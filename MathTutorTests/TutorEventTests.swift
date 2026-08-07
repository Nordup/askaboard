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
}
