import XCTest
import os
@testable import MathTutor

/// Intercepts every request made through a `URLSession` configured with it,
/// so `BackendTutorService` can be exercised against canned SSE bytes with
/// no real network involved.
final class StubURLProtocol: URLProtocol {
    struct Fixture: Sendable {
        var body = ""
        /// When set, delivered as separate `didLoad` calls instead of
        /// `body` in one piece — used to simulate a server flush splitting
        /// a payload across more than one TCP write.
        var bodyChunks: [String]?
        var status = 200
        var lastRequest: URLRequest?
        var lastBody: Data?
    }

    /// A lock rather than a bare `static var`: the loading system reads
    /// this off its own queue, and this project does not have
    /// `nonisolated(unsafe)` in it anywhere (see `DictationTests.swift`,
    /// `StubTranscriptionProtocol`, which sets the precedent this mirrors).
    static let fixture = OSAllocatedUnfairLock<Fixture>(initialState: Fixture())

    static var body: String {
        get { fixture.withLock { $0.body } }
        set { fixture.withLock { $0.body = newValue } }
    }
    static var bodyChunks: [String]? {
        get { fixture.withLock { $0.bodyChunks } }
        set { fixture.withLock { $0.bodyChunks = newValue } }
    }
    static var status: Int {
        get { fixture.withLock { $0.status } }
        set { fixture.withLock { $0.status = newValue } }
    }
    static var lastRequest: URLRequest? { fixture.withLock { $0.lastRequest } }
    static var lastBody: Data? { fixture.withLock { $0.lastBody } }

    static func reset() {
        fixture.withLock { $0 = Fixture() }
    }

    static var stubbedSession: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let capturedRequest = request
        let capturedBody = capturedRequest.httpBody ?? Self.drain(capturedRequest.httpBodyStream)
        let (status, chunks) = Self.fixture.withLock { fixture in
            fixture.lastRequest = capturedRequest
            fixture.lastBody = capturedBody
            return (fixture.status, fixture.bodyChunks ?? [fixture.body])
        }

        let response = HTTPURLResponse(
            url: capturedRequest.url ?? URL(string: "https://example.invalid")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream", "X-Accel-Buffering": "no"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks {
            client?.urlProtocol(self, didLoad: Data(chunk.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// `URLSession` sometimes hands a small POST body to `URLProtocol` as a
    /// stream rather than as `httpBody`. Read it out the same way either way
    /// so `lastBody` is reliable regardless of which one it used.
    private static func drain(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

final class BackendTutorServiceTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    private func makeService() -> BackendTutorService {
        let configuration = BackendConfiguration(baseURL: URL(string: "https://backend.example.com")!, token: "test-token")!
        return BackendTutorService(configuration: configuration, session: StubURLProtocol.stubbedSession)
    }

    func testStreamsEachEventInOrder() async throws {
        StubURLProtocol.body = """
        data: {"type":"status","phase":"thinking","detail":null}

        data: {"type":"text_delta","text":"Nice "}

        data: {"type":"text_delta","text":"work."}

        data: {"type":"done","turn_id":"\(UUID().uuidString)"}


        """
        var events: [TutorEvent] = []
        for try await event in makeService().stream(.fixture()) { events.append(event) }
        XCTAssertEqual(events, [
            .status(.thinking, detail: nil), .textDelta("Nice "), .textDelta("work."), .done,
        ])
    }

    func testSendsTheBearerTokenAndAClientTurnID() async throws {
        StubURLProtocol.body = "data: {\"type\":\"done\",\"turn_id\":\"\(UUID().uuidString)\"}\n\n"
        for try await _ in makeService().stream(.fixture()) {}
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(request.url?.absoluteString, "https://backend.example.com/v1/turn")
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(StubURLProtocol.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertNotNil(UUID(uuidString: json["turn_id"] as? String ?? ""))
        XCTAssertNotNil(UUID(uuidString: json["session_id"] as? String ?? ""))
    }

    func testRequestBodyCarriesTheExpectedFields() async throws {
        StubURLProtocol.body = "data: {\"type\":\"done\",\"turn_id\":\"\(UUID().uuidString)\"}\n\n"
        let request = TutorRequest.fixture(
            messages: [TutorMessage(role: .learner, text: "How do I isolate x?")],
            goal: "Solve for x",
            signal: .dontKnow,
            model: .terra,
            reasoningEffort: .low
        )
        for try await _ in makeService().stream(request) {}
        let body = try XCTUnwrap(StubURLProtocol.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["text"] as? String, "How do I isolate x?")
        XCTAssertEqual(json["goal"] as? String, "Solve for x")
        XCTAssertEqual(json["signal"] as? String, "dontKnow")
        XCTAssertEqual(json["model"] as? String, "gpt-5.6-terra")
        XCTAssertEqual(json["reasoning_effort"] as? String, "low")
    }

    func testAnHTTPErrorSurfacesAsAFailure() async throws {
        StubURLProtocol.status = 401
        StubURLProtocol.body = "Invalid bearer token."
        do {
            for try await _ in makeService().stream(.fixture()) {}
            XCTFail("Expected a thrown error")
        } catch let error as TutorServiceError {
            if case .network(let message) = error {
                XCTAssertEqual(message, "Invalid bearer token.")
            } else {
                XCTFail("Expected .network, got \(error)")
            }
        }
    }

    func testAFailureEventIsYieldedNotThrown() async throws {
        // A turn that fails mid-stream still reaches the caller as a
        // `.failure` event, not a thrown error: the learner may have
        // already seen partial text, and the UI decides how to offer a
        // retry from there.
        StubURLProtocol.body = "data: {\"type\":\"text_delta\",\"text\":\"Some progress. \"}\n\ndata: {\"type\":\"error\",\"message\":\"the model timed out\",\"retryable\":true}\n\n"
        var events: [TutorEvent] = []
        for try await event in makeService().stream(.fixture()) { events.append(event) }
        XCTAssertEqual(events, [
            .textDelta("Some progress. "), .failure(message: "the model timed out", retryable: true),
        ])
    }

    func testAPartialLineIsBufferedUntilItCompletes() async throws {
        // The bytes API delivers whole lines, but a server flush can split
        // a JSON payload across more than one chunk on the wire. Split the
        // first `data:` line itself mid-payload to pin that `bytes.lines`
        // still reassembles it before `TutorEvent.decode` ever sees it.
        let firstLine = "data: {\"type\":\"text_delta\",\"text\":\"whole\"}\n\n"
        let splitIndex = firstLine.index(firstLine.startIndex, offsetBy: 20)
        StubURLProtocol.bodyChunks = [
            String(firstLine[..<splitIndex]),
            String(firstLine[splitIndex...]) + "data: {\"type\":\"done\",\"turn_id\":\"\(UUID().uuidString)\"}\n\n",
        ]
        var text = ""
        for try await event in makeService().stream(.fixture()) {
            if case .textDelta(let chunk) = event { text += chunk }
        }
        XCTAssertEqual(text, "whole")
    }

    // MARK: - TutorServiceRouter.stream(_:)

    func testRouterStreamThrowsMissingAPIKeyWhenConfigurationIsIncomplete() async throws {
        let router = TutorServiceRouter(configurationReader: { nil })
        do {
            for try await _ in router.stream(.fixture()) {}
            XCTFail("Expected a thrown error")
        } catch let error as TutorServiceError {
            if case .missingAPIKey = error {
                // expected
            } else {
                XCTFail("Expected .missingAPIKey, got \(error)")
            }
        }
    }
}
