import XCTest
@testable import MathTutor

final class TutorEventTests: XCTestCase {
    func testDecodesATextDelta() {
        let event = TutorEvent.decode(from: #"data: {"type":"text_delta","text":"Nice"}"#)
        XCTAssertEqual(event, .textDelta("Nice"))
    }

    func testDecodesAStatusWithDetail() {
        let event = TutorEvent.decode(from: #"data: {"type":"status","phase":"looking","detail":"the board"}"#)
        XCTAssertEqual(event, .status(.looking, detail: "the board"))
    }

    func testDecodesAWorkspacePair() {
        let json = #"data: {"type":"workspace","plan":{"title":"T","goal":"G","outcomes":["o"],"steps":["s"],"currentStep":0},"exercise":{"title":"E","prompt":"P","hint":"H","context":"C"}}"#
        guard case .workspace(let plan, let exercise)? = TutorEvent.decode(from: json) else {
            return XCTFail("Expected a workspace event")
        }
        XCTAssertEqual(plan.title, "T")
        XCTAssertEqual(exercise.prompt, "P")
    }

    func testIgnoresKeepAlivesAndComments() {
        XCTAssertNil(TutorEvent.decode(from: ""))
        XCTAssertNil(TutorEvent.decode(from: ": keep-alive"))
    }

    func testIgnoresAnUnknownEventTypeRatherThanThrowing() {
        XCTAssertNil(TutorEvent.decode(from: #"data: {"type":"future_event","x":1}"#))
    }

    func testDecodesARetryableFailure() {
        let event = TutorEvent.decode(from: #"data: {"type":"error","message":"rate limited","retryable":true}"#)
        XCTAssertEqual(event, .failure(message: "rate limited", retryable: true))
    }

    /// The phase the server sends while an `update_board` call's arguments are
    /// streaming — the longest stretch of a drawing turn, and the one the
    /// thread used to have no way to describe.
    func testDecodesTheDrawingPhase() {
        let event = TutorEvent.decode(from: #"data: {"type":"status","phase":"drawing","detail":null}"#)
        XCTAssertEqual(event, .status(.drawing, detail: nil))
    }

    /// The heartbeat repeats whatever phase is current, so the same status
    /// event arrives many times in a turn. It has to stay a plain assignment —
    /// nothing may treat a repeat as a transition.
    func testARepeatedStatusDecodesIdenticallyEveryTime() {
        let line = #"data: {"type":"status","phase":"drawing","detail":null}"#
        XCTAssertEqual(TutorEvent.decode(from: line), TutorEvent.decode(from: line))
    }

    func testDecodesAStepEvent() {
        let line = #"data: {"type":"step","id":"call_a","tool":"update_board","label":"Drawing on the board"}"#
        XCTAssertEqual(
            TutorEvent.decode(from: line),
            .step(id: "call_a", tool: "update_board", label: "Drawing on the board")
        )
    }

    func testDecodesSearchSourcesWithANullSnippet() {
        let line = #"data: {"type":"search_sources","search_id":"s_1","query":"radical equations","sources":[{"id":"a","title":"Radical Equations","url":"https://example.com/radical","snippet":null},{"id":"b","title":"Checking roots","url":"https://example.org/roots","snippet":"Substitute back."}]}"#
        XCTAssertEqual(
            TutorEvent.decode(from: line),
            .searchSources(
                searchID: "s_1",
                query: "radical equations",
                sources: [
                    TutorSource(id: "a", title: "Radical Equations", url: "https://example.com/radical", snippet: nil),
                    TutorSource(id: "b", title: "Checking roots", url: "https://example.org/roots", snippet: "Substitute back."),
                ]
            )
        )
    }

    func testASearchSourcesEventMissingRequiredFieldsIsRefused() {
        let missingSources = #"data: {"type":"search_sources","search_id":"s_1","query":"radical"}"#
        XCTAssertNil(TutorEvent.decode(from: missingSources))

        let missingID = #"data: {"type":"search_sources","query":"radical","sources":[]}"#
        XCTAssertNil(TutorEvent.decode(from: missingID))
    }

    func testAStepMissingItsIDIsIgnored() {
        let line = #"data: {"type":"step","tool":"update_board","label":"Drawing"}"#
        XCTAssertNil(TutorEvent.decode(from: line))
    }

    func testAnUnknownEventTypeIsStillIgnored() {
        let line = #"data: {"type":"something_new","text":"hi"}"#
        XCTAssertNil(TutorEvent.decode(from: line))
    }
}
