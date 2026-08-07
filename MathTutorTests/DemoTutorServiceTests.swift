import XCTest
@testable import MathTutor

extension TutorRequest {
    /// Defaults for every field so a test only has to name what it cares about.
    static func fixture(
        messages: [TutorMessage] = [TutorMessage(role: .learner, text: "Hello")],
        goal: String? = "Learn algebra",
        plan: SessionPlan? = nil,
        exercise: Exercise? = nil,
        imageData: Data? = nil,
        imageRegionDescription: String? = nil,
        signal: LearningSignal? = nil,
        model: ModelChoice = .sol,
        reasoningEffort: ReasoningEffort = .defaultValue
    ) -> TutorRequest {
        TutorRequest(
            messages: messages,
            goal: goal,
            exercise: exercise,
            plan: plan,
            imageData: imageData,
            imageRegionDescription: imageRegionDescription,
            signal: signal,
            model: model,
            reasoningEffort: reasoningEffort
        )
    }
}

final class DemoTutorServiceTests: XCTestCase {
    func testDemoStreamEndsWithDone() async throws {
        var events: [TutorEvent] = []
        for try await event in DemoTutorService().stream(.fixture()) { events.append(event) }
        XCTAssertEqual(events.last, .done)
    }

    func testDemoStreamEmitsThinkingFirst() async throws {
        var events: [TutorEvent] = []
        for try await event in DemoTutorService().stream(.fixture()) { events.append(event) }
        XCTAssertEqual(events.first, .status(.thinking, detail: nil))
    }

    func testDontKnowSignalStillProducesItsReassurance() async throws {
        var text = ""
        for try await event in DemoTutorService().stream(.fixture(signal: .dontKnow)) {
            if case .textDelta(let chunk) = event { text += chunk }
        }
        XCTAssertTrue(text.contains("useful signal, not a dead end"))
    }

    func testAnExistingPairIsReemittedAsAWorkspaceEvent() async throws {
        let request = TutorRequest.fixture(plan: .radicalEquation, exercise: .radicalEquation)
        var sawWorkspace = false
        for try await event in DemoTutorService().stream(request) {
            if case .workspace = event { sawWorkspace = true }
        }
        XCTAssertTrue(sawWorkspace)
    }
}
