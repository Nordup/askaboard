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

    /// `session_id` must be the caller's `sessionID`, not a fresh UUID minted
    /// per call — a fresh id every turn is exactly the bug that kept the
    /// backend from ever accumulating conversation context (see
    /// `BackendTutorService.body(for:)`).
    func testSessionIDIsCarriedFromTheRequestNotGeneratedFresh() async throws {
        StubURLProtocol.body = "data: {\"type\":\"done\",\"turn_id\":\"\(UUID().uuidString)\"}\n\n"
        let sessionID = UUID()
        for try await _ in makeService().stream(.fixture(sessionID: sessionID)) {}
        let body = try XCTUnwrap(StubURLProtocol.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["session_id"] as? String, sessionID.uuidString)
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

    /// Coverage this suite lost when `OpenAITutorService` (and its own
    /// image-embedding tests) was deleted: the backend's own image fields —
    /// unrelated to the old OpenAI Responses API `input_image` shape — still
    /// need to carry the board capture and region label intact.
    func testRequestBodyCarriesImageDataAndRegion() async throws {
        StubURLProtocol.body = "data: {\"type\":\"done\",\"turn_id\":\"\(UUID().uuidString)\"}\n\n"
        let imageData = Data([1, 2, 3])
        let request = TutorRequest.fixture(
            imageData: imageData,
            imageRegionDescription: "the selected rectangle",
            signal: .evaluate
        )
        for try await _ in makeService().stream(request) {}
        let body = try XCTUnwrap(StubURLProtocol.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["image_base64"] as? String, imageData.base64EncodedString())
        XCTAssertEqual(json["image_region"] as? String, "the selected rectangle")
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

    /// A turn is a deliberately long-lived stream, and `URLSession`'s 60-second
    /// default is an *inactivity* timeout — it ended real turns while the tutor
    /// was mid-diagram, after the model's work had been generated and billed.
    /// Asserted on the request rather than only on the session because
    /// `URLRequest` carries its own 60-second default that would otherwise be
    /// the one in force.
    func testTheTurnRequestOutlivesTheSixtySecondDefault() throws {
        let configuration = BackendConfiguration(
            baseURL: URL(string: "https://backend.example.com")!, token: "test-token"
        )!
        let request = try BackendTutorService.urlRequest(
            for: .fixture(), configuration: configuration
        )
        XCTAssertEqual(request.timeoutInterval, BackendTutorService.streamTimeout)
        XCTAssertGreaterThan(BackendTutorService.streamTimeout, 60)
    }

    /// The session the app actually streams on — `.shared` would carry the 60
    /// seconds no matter what the request said on some paths.
    func testTheStreamingSessionCarriesTheSameTimeout() {
        XCTAssertEqual(
            BackendTutorService.streamingSession.configuration.timeoutIntervalForRequest,
            BackendTutorService.streamTimeout
        )
    }

    // MARK: - TutorServiceRouter.stream(_:)

    func testRouterStreamThrowsNotConfiguredWhenThereIsNoUsableToken() async throws {
        let router = TutorServiceRouter(configurationReader: { nil })
        do {
            for try await _ in router.stream(.fixture()) {}
            XCTFail("Expected a thrown error")
        } catch let error as TutorServiceError {
            if case .notConfigured = error {
                // expected
            } else {
                XCTFail("Expected .notConfigured, got \(error)")
            }
        }
    }

    // MARK: - AttachmentUploader

    func testMultipartBodyCarriesTheSessionAndTheFile() throws {
        let sessionID = UUID()
        let body = AttachmentUploader.multipartBody(
            boundary: "BOUNDARY",
            sessionID: sessionID,
            filename: "worksheet.pdf",
            contentType: "application/pdf",
            data: Data("%PDF-1.4".utf8)
        )
        let text = String(decoding: body, as: UTF8.self)

        // Each assertion pins the `\r\n` on both sides of the piece it checks,
        // not just the words — a regression that dropped CRLF everywhere
        // except the very last line would still pass a bare `.contains` on
        // the words alone, which is exactly the "miserable to debug" bug the
        // production code's own comment warns about.
        XCTAssertTrue(text.contains(
            "--BOUNDARY\r\nContent-Disposition: form-data; name=\"session_id\"\r\n\r\n"
        ))
        XCTAssertTrue(text.contains("\r\n\(sessionID.uuidString)\r\n--BOUNDARY\r\n"))
        XCTAssertTrue(text.contains(
            "Content-Disposition: form-data; name=\"file\"; filename=\"worksheet.pdf\"\r\n"
                + "Content-Type: application/pdf\r\n\r\n"
        ))
        XCTAssertTrue(text.contains("\r\n%PDF-1.4\r\n--BOUNDARY--\r\n"))
    }

    func testMultipartBodyEscapesQuotesInTheFilename() throws {
        // iOS permits a `"` in a Files-picked filename. Unescaped, it would
        // close the `Content-Disposition` header's quoting early and hand the
        // server a malformed part.
        let body = AttachmentUploader.multipartBody(
            boundary: "BOUNDARY",
            sessionID: UUID(),
            filename: "my \"best\" attempt.pdf",
            contentType: "application/pdf",
            data: Data("stub".utf8)
        )
        let text = String(decoding: body, as: UTF8.self)

        XCTAssertTrue(text.contains(
            "Content-Disposition: form-data; name=\"file\"; filename=\"my \\\"best\\\" attempt.pdf\"\r\n"
        ))
    }

    func testUploadRequestTargetsTheAttachmentsRouteWithTheBearer() throws {
        let configuration = BackendConfiguration(
            baseURL: URL(string: "https://example.test")!, token: "abc"
        )
        let request = AttachmentUploader.urlRequest(
            boundary: "BOUNDARY", configuration: configuration!, body: Data()
        )

        XCTAssertEqual(request.url?.path, "/v1/attachments")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Content-Type"),
            "multipart/form-data; boundary=BOUNDARY"
        )
    }

    func testAnUploadRefusalSurfacesTheServersSentence() async {
        // The server writes that sentence for a chip in the composer. Replacing it
        // with a generic message here would be writing it twice, worse.
        let refusal = AttachmentUploader.refusal(
            statusCode: 415, body: #"{"detail":"I can’t read mystery.bin."}"#
        )
        XCTAssertEqual(refusal, "I can’t read mystery.bin.")
    }

    // MARK: - AttachmentUploader.upload(_:filename:contentType:sessionID:)
    //
    // The three tests above exercise the static helpers in isolation. These
    // drive `upload()` itself through the same `StubURLProtocol` harness
    // `BackendTutorServiceTests` uses above, so the async path — status
    // branching, the `UploadResponse` decode, the `MessageAttachment` field
    // mapping, and the base64 thumbnail decode — has coverage a typo in the
    // field mapping could actually fail.

    private func makeUploader() -> AttachmentUploader {
        let configuration = BackendConfiguration(
            baseURL: URL(string: "https://backend.example.com")!, token: "test-token"
        )!
        return AttachmentUploader(configuration: configuration, session: StubURLProtocol.stubbedSession)
    }

    func testUploadMapsEveryFieldOnA200() async throws {
        let responseID = UUID()
        let thumbnailBytes = Data([0xFF, 0xD8, 0xFF, 0xD9])
        StubURLProtocol.body = """
        {"id":"\(responseID.uuidString)","kind":"image","page_count":1,\
        "thumbnail_base64":"\(thumbnailBytes.base64EncodedString())"}
        """

        let uploaded = try await makeUploader().upload(
            Data("stub bytes".utf8),
            filename: "photo.jpg",
            contentType: "image/jpeg",
            sessionID: UUID()
        )

        XCTAssertEqual(uploaded.attachment.id, responseID)
        // `filename` comes from the *argument*, not the response body — the
        // server's `UploadResponse` carries no filename field at all.
        XCTAssertEqual(uploaded.attachment.filename, "photo.jpg")
        XCTAssertEqual(uploaded.attachment.kind, "image")
        XCTAssertEqual(uploaded.attachment.pageCount, 1)
        XCTAssertEqual(uploaded.thumbnail, thumbnailBytes)
    }

    func testUploadRefusalSurfacesTheServersSentenceEndToEnd() async {
        StubURLProtocol.status = 415
        StubURLProtocol.body = #"{"detail":"I can’t read mystery.bin."}"#

        do {
            _ = try await makeUploader().upload(
                Data(), filename: "mystery.bin", contentType: "application/octet-stream", sessionID: UUID()
            )
            XCTFail("Expected a thrown error")
        } catch let error as TutorServiceError {
            if case .network(let message) = error {
                XCTAssertEqual(message, "I can’t read mystery.bin.")
            } else {
                XCTFail("Expected .network, got \(error)")
            }
        }
    }

    func testUploadThrowsInvalidResponseWhenA200BodyIsUnreadable() async {
        StubURLProtocol.status = 200
        StubURLProtocol.body = "not json"

        do {
            _ = try await makeUploader().upload(
                Data(), filename: "worksheet.pdf", contentType: "application/pdf", sessionID: UUID()
            )
            XCTFail("Expected a thrown error")
        } catch let error as TutorServiceError {
            if case .invalidResponse = error {
                // expected
            } else {
                XCTFail("Expected .invalidResponse, got \(error)")
            }
        }
    }

    // MARK: - Attachment ids on the turn

    /// The field is absent, not empty — so every turn the app has ever sent is
    /// byte-identical to what it was before the composer grew a `+`.
    func testBodyOmitsAttachmentIDsWhenThereAreNone() {
        let body = BackendTutorService.body(for: .fixture())
        XCTAssertNil(body["attachment_ids"])
    }

    /// Strings, in the order the learner picked them: `attachment_ids` on the
    /// wire is a list of the ids `POST /v1/attachments` minted, and the server
    /// resolves each to a file it already holds.
    func testBodyCarriesAttachmentIDsAsStrings() {
        let first = UUID()
        let second = UUID()
        var request = TutorRequest.fixture()
        request.attachmentIDs = [first, second]

        let body = BackendTutorService.body(for: request)

        XCTAssertEqual(
            body["attachment_ids"] as? [String],
            [first.uuidString, second.uuidString]
        )
    }
}
