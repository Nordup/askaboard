import Foundation
import PencilKit
import UIKit
import XCTest
@testable import MathTutor

final class MathTutorTests: XCTestCase {
    func testAppearancePreferenceDefaultsToLightAndRoundTrips() throws {
        let suiteName = "MathTutorTests.appearance.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertEqual(AppearancePreference.load(from: defaults), .light)
        AppearancePreference.save(.dark, to: defaults)
        XCTAssertEqual(AppearancePreference.load(from: defaults), .dark)
        AppearancePreference.save(.system, to: defaults)
        XCTAssertEqual(AppearancePreference.load(from: defaults), .system)

        defaults.set("unsupported", forKey: AppearancePreference.key)
        XCTAssertEqual(AppearancePreference.load(from: defaults), .light)
    }

    func testCanvasViewportMapperTracksPanAndZoom() {
        let bounds = CGRect(x: 80, y: 120, width: 1_000, height: 700)
        let selectedViewport = CGRect(x: 100, y: 200, width: 240, height: 120)
        let drawingRect = CanvasViewportMapper.drawingRect(
            for: selectedViewport,
            canvasBounds: bounds,
            zoomScale: 2
        )

        XCTAssertEqual(drawingRect.origin.x, 90, accuracy: 0.001)
        XCTAssertEqual(drawingRect.origin.y, 160, accuracy: 0.001)
        XCTAssertEqual(drawingRect.width, 120, accuracy: 0.001)
        XCTAssertEqual(drawingRect.height, 60, accuracy: 0.001)
    }

    func testPencilCanvasConfigurationCentersAnInfiniteBoard() {
        let viewport = CGSize(width: 1_024, height: 768)
        let contentSize = PencilCanvasConfiguration.contentSize(for: viewport)

        XCTAssertEqual(contentSize.width, PencilCanvasConfiguration.boardExtent)
        XCTAssertEqual(contentSize.height, PencilCanvasConfiguration.boardExtent)
        XCTAssertEqual(PencilCanvasConfiguration.boardOrigin, CGPoint(x: 25_000, y: 25_000))

        // The session starts in the middle of the board, not at a corner, which
        // is what makes panning up and left possible at all.
        let offset = PencilCanvasConfiguration.initialContentOffset(viewport: viewport)
        XCTAssertEqual(offset.x, 25_000 - 512, accuracy: 0.001)
        XCTAssertEqual(offset.y, 25_000 - 384, accuracy: 0.001)

        XCTAssertEqual(PencilCanvasConfiguration.minimumZoomScale, 0.25, accuracy: 0.0001)
        XCTAssertLessThan(PencilCanvasConfiguration.minimumZoomScale, PencilCanvasConfiguration.defaultZoomScale)
        XCTAssertLessThan(PencilCanvasConfiguration.defaultZoomScale, PencilCanvasConfiguration.maximumZoomScale)
    }

    func testCanvasScrollerCentersInkAndClampsAtBoardEdges() {
        let viewport = CGSize(width: 1_000, height: 800)
        let board = CGSize(width: 50_000, height: 50_000)

        let centered = CanvasScroller.offset(
            centering: CGRect(x: 24_800, y: 24_900, width: 400, height: 200),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(centered.x, 24_500, accuracy: 0.001)
        XCTAssertEqual(centered.y, 24_600, accuracy: 0.001)

        // Ink near a corner cannot be centered; the offset clamps to the
        // scrollable range instead of scrolling past the board.
        let clampedLow = CanvasScroller.offset(
            centering: CGRect(x: 10, y: 10, width: 20, height: 20),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(clampedLow.x, 0, accuracy: 0.001)
        XCTAssertEqual(clampedLow.y, 0, accuracy: 0.001)

        let clampedHigh = CanvasScroller.offset(
            centering: CGRect(x: 49_980, y: 49_980, width: 10, height: 10),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(clampedHigh.x, 49_000, accuracy: 0.001)
        XCTAssertEqual(clampedHigh.y, 49_200, accuracy: 0.001)

        // The target is unscaled drawing space, the result is scaled scroll
        // space, so the same ink sits twice as far out at 2x zoom.
        let zoomed = CanvasScroller.offset(
            centering: CGRect(x: 24_800, y: 24_900, width: 400, height: 200),
            viewport: viewport,
            zoomScale: 2,
            scaledContentSize: CGSize(width: 100_000, height: 100_000)
        )
        XCTAssertEqual(zoomed.x, 49_500, accuracy: 0.001)
        XCTAssertEqual(zoomed.y, 49_600, accuracy: 0.001)
    }

    func testDrawingDataRoundTripsCoordinatesNearBoardOrigin() throws {
        let origin = PencilCanvasConfiguration.boardOrigin
        let locations = [
            CGPoint(x: origin.x, y: origin.y),
            CGPoint(x: origin.x + 37.5, y: origin.y - 12.25),
            CGPoint(x: origin.x + 120.125, y: origin.y + 240.75)
        ]
        let controlPoints = locations.enumerated().map { index, point in
            PKStrokePoint(
                location: point,
                timeOffset: Double(index) * 0.02,
                size: CGSize(width: 8, height: 8),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let path = PKStrokePath(controlPoints: controlPoints, creationDate: Date(timeIntervalSinceReferenceDate: 0))
        let drawing = PKDrawing(strokes: [
            PKStroke(ink: PKInk(.pen, color: .black), path: path, transform: .identity, mask: nil, randomSeed: 13)
        ])

        let restored = try PKDrawing(data: drawing.dataRepresentation())
        let restoredPath = try XCTUnwrap(restored.strokes.first?.path)
        XCTAssertEqual(restoredPath.count, locations.count)

        // Serialized ink keeps sub-pixel accuracy this far from zero: a 32-bit
        // float quantizes to ~0.002pt at 25,000, far below the 0.5pt physical
        // pixel. This fails loudly if the board extent ever grows enough for
        // that error to become visible.
        for (index, expected) in locations.enumerated() {
            XCTAssertEqual(restoredPath[index].location.x, expected.x, accuracy: 0.01)
            XCTAssertEqual(restoredPath[index].location.y, expected.y, accuracy: 0.01)
        }
    }

    @MainActor
    func testPencilCanvasConfigurationUsesPencilOnlyAndNativeFingerGestures() {
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        PencilCanvasConfiguration.configure(canvas, viewport: canvas.bounds.size)

        XCTAssertEqual(canvas.drawingPolicy, .pencilOnly)
        XCTAssertTrue(canvas.isScrollEnabled)
        XCTAssertEqual(canvas.minimumZoomScale, PencilCanvasConfiguration.minimumZoomScale)
        XCTAssertEqual(canvas.maximumZoomScale, PencilCanvasConfiguration.maximumZoomScale)
        XCTAssertEqual(canvas.zoomScale, PencilCanvasConfiguration.defaultZoomScale)
        XCTAssertEqual(canvas.panGestureRecognizer.allowedTouchTypes.first?.intValue, UITouch.TouchType.direct.rawValue)
        XCTAssertEqual(canvas.pinchGestureRecognizer?.allowedTouchTypes.first?.intValue, UITouch.TouchType.direct.rawValue)
    }

    @MainActor
    func testCanvasCaptureProducesBlackInkAndEmbedsExactPNGInRequest() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black)
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let imageData = try XCTUnwrap(capture.snapshotData())
        let pixels = try pixelStats(for: imageData)
        XCTAssertGreaterThan(pixels.darkPixelCount, 40, "A black PKDrawing must survive full-canvas capture")

        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Check my board")],
            goal: "Check my board",
            exercise: sampleExercise,
            plan: samplePlan,
            imageData: imageData,
            imageRegionDescription: "the full canvas",
            signal: .evaluate,
            model: .luna
        )
        let body = try responseBodyJSON(for: request)
        let input = try XCTUnwrap(body["input"] as? [[String: Any]])
        let userContent = try XCTUnwrap(input.last?["content"] as? [[String: Any]])
        let image = try XCTUnwrap(userContent.first(where: { $0["type"] as? String == "input_image" }))
        XCTAssertEqual(image["image_url"] as? String, "data:image/png;base64,\(imageData.base64EncodedString())")
    }

    @MainActor
    func testCanvasCaptureKeepsSelectedInkAfterPanAndZoom() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black)
        let capture = CanvasCapture()
        capture.canvasView = canvas

        canvas.setZoomScale(2, animated: false)
        canvas.contentOffset = CGPoint(x: 180, y: 220)
        XCTAssertEqual(canvas.bounds.minX, 180, accuracy: 0.001)
        XCTAssertEqual(canvas.bounds.minY, 220, accuracy: 0.001)

        let fullData = try XCTUnwrap(capture.snapshotData())
        let selectedViewport = CGRect(x: 0, y: 240, width: 500, height: 300)
        let selectedData = try XCTUnwrap(capture.snapshotData(region: selectedViewport))
        XCTAssertGreaterThan(try pixelStats(for: fullData).darkPixelCount, 40)
        XCTAssertGreaterThan(try pixelStats(for: selectedData).darkPixelCount, 20, "The selected visible region must retain its ink after pan and zoom")

        let expected = CanvasViewportMapper.drawingRect(
            for: selectedViewport,
            canvasBounds: canvas.bounds,
            zoomScale: canvas.zoomScale
        )
        XCTAssertEqual(expected.origin.x, 90, accuracy: 0.001)
        XCTAssertEqual(expected.origin.y, 230, accuracy: 0.001)
        XCTAssertEqual(expected.width, 250, accuracy: 0.001)
        XCTAssertEqual(expected.height, 150, accuracy: 0.001)
    }

    @MainActor
    func testCanvasCapturePreservesLightInkContrast() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .white)
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let imageData = try XCTUnwrap(capture.snapshotData())
        let pixels = try pixelStats(for: imageData)
        XCTAssertGreaterThan(pixels.nonWhitePixelCount, 40, "Light PencilKit ink must remain visible in the evaluation PNG")
    }

    @MainActor
    func testCanvasCaptureFlattensLightInkOnWhiteBackgroundInDarkTrait() throws {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas

        var imageData: Data?
        UITraitCollection(userInterfaceStyle: .dark).performAsCurrent {
            canvas.drawing = makeDrawing(color: .label)
            imageData = capture.snapshotData()
        }

        let pixels = try pixelStats(for: XCTUnwrap(imageData))
        XCTAssertGreaterThan(
            pixels.darkPixelCount,
            40,
            "Light dynamic PencilKit ink must remain visible on the flattened white background"
        )
    }

    @MainActor
    func testCenterOnContentBringsDistantInkIntoTheViewport() {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black, origin: CGPoint(x: 30_000, y: 41_000))
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let viewportRect = CGRect(origin: .zero, size: canvas.bounds.size)
        let before = CanvasViewportMapper.drawingRect(
            for: viewportRect,
            canvasBounds: canvas.bounds,
            zoomScale: canvas.zoomScale
        )
        XCTAssertFalse(before.intersects(canvas.drawing.bounds), "Ink 30,000pt away must start off screen")

        capture.centerOnContent(animated: false)

        let after = CanvasViewportMapper.drawingRect(
            for: viewportRect,
            canvasBounds: canvas.bounds,
            zoomScale: canvas.zoomScale
        )
        XCTAssertTrue(
            after.contains(CGPoint(x: canvas.drawing.bounds.midX, y: canvas.drawing.bounds.midY)),
            "Centering must scroll the board to wherever the student's ink lives"
        )
    }

    @MainActor
    func testCenterOnContentReturnsToTheBoardOriginWhenEmpty() {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas
        canvas.contentOffset = CGPoint(x: 40_000, y: 40_000)

        capture.centerOnContent(animated: false)

        XCTAssertEqual(
            canvas.contentOffset.x,
            PencilCanvasConfiguration.boardOrigin.x - canvas.bounds.width / 2,
            accuracy: 0.5
        )
        XCTAssertEqual(
            canvas.contentOffset.y,
            PencilCanvasConfiguration.boardOrigin.y - canvas.bounds.height / 2,
            accuracy: 0.5
        )
    }

    @MainActor
    func testEvaluationPersistsLearnerAndTutorTurnsAndDismissKeepsHistory() async throws {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        let initialMessageCount = store.session.messages.count

        store.evaluate(imageData: Data([1, 2, 3]), regionDescription: "the selected rectangle")
        for _ in 0..<50 where store.isEvaluating {
            try await Task.sleep(for: .milliseconds(20))
        }

        XCTAssertFalse(store.isEvaluating)
        let newMessages = Array(store.session.messages.dropFirst(initialMessageCount))
        let evaluationTurn = try XCTUnwrap(newMessages.first(where: { $0.signal == .evaluate }))
        XCTAssertEqual(evaluationTurn.role, .learner)
        XCTAssertTrue(evaluationTurn.text.lowercased().contains("selected rectangle"))

        let tutorReply = try XCTUnwrap(newMessages.first(where: { $0.role == .tutor }))
        XCTAssertFalse(tutorReply.text.isEmpty)
        XCTAssertEqual(store.evaluationText, tutorReply.text)

        store.clearEvaluation()
        XCTAssertNil(store.evaluationText)
        XCTAssertTrue(store.session.messages.contains(tutorReply), "Dismissing the highlighted feedback must not remove conversation history")
    }

    func testNewSessionsDefaultToLuna() {
        XCTAssertEqual(LearningSession.empty.selectedModel, .luna)
        XCTAssertEqual(LearningSession.empty.reasoningEffort, .high)
    }

    func testReasoningEffortRoundTripsAndUnknownValuesUseHighDefault() throws {
        for effort in ReasoningEffort.allCases {
            let data = try JSONEncoder().encode(effort)
            XCTAssertEqual(try JSONDecoder().decode(ReasoningEffort.self, from: data), effort)
        }

        let unknown = Data(#""future_effort""#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(ReasoningEffort.self, from: unknown), .high)
    }

    func testLearningSessionBackwardDecodeDefaultsMissingReasoningEffort() throws {
        var sessionObject = try jsonObject(for: LearningSession.empty)
        sessionObject.removeValue(forKey: "reasoningEffort")
        let legacyData = try JSONSerialization.data(withJSONObject: sessionObject)
        let decodedLegacy = try JSONDecoder().decode(LearningSession.self, from: legacyData)
        XCTAssertEqual(decodedLegacy.reasoningEffort, .high)

        sessionObject["reasoningEffort"] = "future_effort"
        let unknownData = try JSONSerialization.data(withJSONObject: sessionObject)
        let decodedUnknown = try JSONDecoder().decode(LearningSession.self, from: unknownData)
        XCTAssertEqual(decodedUnknown.reasoningEffort, .high)
    }

    func testReasoningEffortIsForwardedToResponsesBody() throws {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Use a concise route")],
            goal: "Use a concise route",
            exercise: nil,
            plan: nil,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna,
            reasoningEffort: .low
        )
        let body = try responseBodyJSON(for: request)
        XCTAssertEqual((body["reasoning"] as? [String: Any])?["effort"] as? String, "low")
    }

    @MainActor
    func testStoreReasoningEffortSetterPersistsInSession() {
        let store = TutorStore(service: DemoTutorService())
        store.setReasoningEffort(.xhigh)
        XCTAssertEqual(store.session.reasoningEffort, .xhigh)
        store.resetSession()
        XCTAssertEqual(store.session.reasoningEffort, .high)
    }

    func testRouterThrowsMissingAPIKeyInsteadOfUsingDemoFallback() async throws {
        let router = TutorServiceRouter(apiKeyReader: { nil })
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Explain fractions")],
            goal: "Explain fractions",
            exercise: nil,
            plan: nil,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna
        )

        do {
            _ = try await router.respond(to: request)
            XCTFail("A router without a key must not silently use demo content")
        } catch let error as TutorServiceError {
            if case .missingAPIKey = error {
                // expected
            } else {
                XCTFail("Expected missingAPIKey, got \(error)")
            }
        }
    }

    func testResponsesBodyUsesLunaHighReasoningAndNullableFirstTurnSchema() throws {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Give me one problem to diagnose")],
            goal: "Give me one problem to diagnose",
            exercise: nil,
            plan: nil,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna
        )
        let body = try responseBodyJSON(for: request)
        XCTAssertEqual(body["model"] as? String, ModelChoice.luna.rawValue)
        XCTAssertEqual((body["reasoning"] as? [String: Any])?["effort"] as? String, "high")
        let format = ((body["text"] as? [String: Any])?["format"] as? [String: Any])
        XCTAssertEqual(format?["type"] as? String, "json_schema")
        XCTAssertEqual(format?["name"] as? String, "learning_session")
        XCTAssertEqual(format?["strict"] as? Bool, true)
        let schema = try XCTUnwrap(format?["schema"] as? [String: Any])
        let properties = try XCTUnwrap(schema["properties"] as? [String: Any])
        let plan = try XCTUnwrap(properties["plan"] as? [String: Any])
        let exercise = try XCTUnwrap(properties["exercise"] as? [String: Any])
        XCTAssertEqual(plan["type"] as? [String], ["object", "null"])
        XCTAssertEqual(exercise["type"] as? [String], ["object", "null"])
        XCTAssertEqual(schema["required"] as? [String], ["reply", "plan", "exercise"])
    }

    func testResponsesBodyKeepsStrictSchemaForExistingWorkspaceFollowUp() throws {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Give me another equation to try")],
            goal: "Practice algebra",
            exercise: sampleExercise,
            plan: samplePlan,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna
        )

        let body = try responseBodyJSON(for: request)
        let format = try XCTUnwrap((body["text"] as? [String: Any])?["format"] as? [String: Any])
        XCTAssertEqual(format["type"] as? String, "json_schema")
        XCTAssertEqual(format["name"] as? String, "learning_session")
        XCTAssertEqual(format["strict"] as? Bool, true)
    }

    func testEveryTurnUsesStrictSchemaAndMarkdownFormattingContract() throws {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Show the next two steps")],
            goal: "Practice algebra",
            exercise: sampleExercise,
            plan: samplePlan,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna
        )

        let body = try responseBodyJSON(for: request)
        let format = try XCTUnwrap((body["text"] as? [String: Any])?["format"] as? [String: Any])
        let schema = try XCTUnwrap(format["schema"] as? [String: Any])
        XCTAssertEqual(format["type"] as? String, "json_schema")
        XCTAssertEqual(format["strict"] as? Bool, true)
        XCTAssertEqual(schema["required"] as? [String], ["reply", "plan", "exercise"])

        let input = try XCTUnwrap(body["input"] as? [[String: Any]])
        let content = try XCTUnwrap(input.first(where: { $0["role"] as? String == "user" })?["content"] as? [[String: Any]])
        let prompt = try XCTUnwrap(content.first?["text"] as? String)
        XCTAssertTrue(prompt.contains("CONVERSATION TRANSCRIPT"))
        XCTAssertTrue(TutorPromptPolicy.system.contains("blank lines"))
        XCTAssertTrue(TutorPromptPolicy.system.contains("headings"))
        XCTAssertTrue(TutorPromptPolicy.system.contains("fenced code"))
        XCTAssertTrue(TutorPromptPolicy.system.contains("Unicode/plain-text math"))
        XCTAssertTrue(TutorPromptPolicy.system.contains("single newline"))
        XCTAssertFalse(TutorPromptPolicy.system.contains("$...$"))
    }

    func testTutorPromptRequestsMarkdownWithoutUnrenderedLatexMath() {
        let policy = TutorPromptPolicy.system
        XCTAssertTrue(policy.contains("polished Markdown"))
        XCTAssertTrue(policy.contains("readable Unicode/plain-text math"))
        XCTAssertTrue(policy.contains("does not render LaTeX math"))
        XCTAssertFalse(policy.contains("$...$"))
        XCTAssertFalse(policy.contains("$$...$$"))
    }

    @MainActor
    func testStructuredFollowUpReplacesWorkspaceAndNullChatPreservesIt() async throws {
        let replacementPlan = SessionPlan(
            title: "Coordinate confidence",
            goal: "Understand a coordinate transformation",
            outcomes: ["Track each point through the rule"],
            steps: ["Name the input point", "Apply the rule", "Check the output"],
            currentStep: 0
        )
        let replacementExercise = Exercise(
            title: "Try a transformation",
            prompt: "Reflect (2, -1) across the y-axis.",
            hint: "What changes sign when you reflect across the y-axis?",
            context: "A coordinate geometry exercise"
        )
        let responses = try [
            structuredResponsePayload(reply: "A starter exercise is ready.", plan: samplePlan, exercise: sampleExercise),
            structuredResponsePayload(reply: "Here is a new board exercise.", plan: replacementPlan, exercise: replacementExercise),
            structuredResponsePayload(reply: "We can discuss that without changing your board.", plan: nil, exercise: nil)
        ]
        let service = SequencedStructuredTutorService(payloads: responses)
        let keychain = KeychainStore()
        _ = keychain.saveAPIKey("math-tutor-unit-test-key")
        defer { keychain.removeAPIKey() }
        let store = TutorStore(service: service, keychain: keychain)
        store.resetSession()

        store.send("Give me a starter algebra problem")
        try await waitForTutorRequest(on: store)
        XCTAssertEqual(store.session.plan, samplePlan)
        XCTAssertEqual(store.session.exercise, sampleExercise)

        store.send("Give me another exercise on coordinate geometry")
        try await waitForTutorRequest(on: store)
        XCTAssertEqual(store.session.plan, replacementPlan)
        XCTAssertEqual(store.session.exercise, replacementExercise)

        store.send("Explain why the reflection changes the x-coordinate")
        try await waitForTutorRequest(on: store)
        XCTAssertEqual(store.session.plan, replacementPlan, "A null/null ordinary-chat response must preserve the current workspace")
        XCTAssertEqual(store.session.exercise, replacementExercise, "A null/null ordinary-chat response must preserve the current workspace")
    }

    func testResponsesBodyCarriesOriginalImageInput() throws {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Please check my writing")],
            goal: "Please check my writing",
            exercise: sampleExercise,
            plan: samplePlan,
            imageData: Data([1, 2, 3]),
            imageRegionDescription: "the full canvas",
            signal: .evaluate,
            model: .luna
        )
        let body = try responseBodyJSON(for: request)
        let input = try XCTUnwrap(body["input"] as? [[String: Any]])
        let user = try XCTUnwrap(input.first(where: { $0["role"] as? String == "user" }))
        let content = try XCTUnwrap(user["content"] as? [[String: Any]])
        let image = try XCTUnwrap(content.first(where: { $0["type"] as? String == "input_image" }))
        XCTAssertEqual(image["detail"] as? String, "original")
        XCTAssertEqual(image["image_url"] as? String, "data:image/png;base64,AQID")
    }

    func testLiveRequestPathsUseOneLeanTutorPolicy() throws {
        let onboarding = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Teach me one algebra problem")],
            goal: "Teach me one algebra problem",
            exercise: nil,
            plan: nil,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna
        )
        let followUp = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "I don't know what to do next")],
            goal: "Solve an algebra problem",
            exercise: sampleExercise,
            plan: samplePlan,
            imageData: nil,
            imageRegionDescription: nil,
            signal: .dontKnow,
            model: .luna
        )
        let evaluation = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Please check my writing")],
            goal: "Solve an algebra problem",
            exercise: sampleExercise,
            plan: samplePlan,
            imageData: Data([1, 2, 3]),
            imageRegionDescription: "the full canvas",
            signal: .evaluate,
            model: .luna
        )

        for request in [onboarding, followUp, evaluation] {
            let body = try responseBodyJSON(for: request)
            let input = try XCTUnwrap(body["input"] as? [[String: Any]])
            let system = try XCTUnwrap(input.first(where: { $0["role"] as? String == "system" })?["content"] as? String)
            XCTAssertEqual(system, TutorPromptPolicy.system)
            XCTAssertTrue(system.contains("across all areas of mathematics"))
            XCTAssertTrue(system.contains("explain, solve, check work, or chat directly"))
            XCTAssertTrue(system.contains("otherwise set both to null"))
            XCTAssertTrue(system.contains("whiteboard screenshots"))
            XCTAssertTrue(system.contains("readable Unicode/plain-text math"))
            XCTAssertFalse(system.contains("radical"))
        }
    }

    func testResponsesParserFindsNestedOutputText() throws {
        let payload = #"{"output":[{"type":"message","content":[{"type":"output_text","text":"First hint."},{"type":"output_text","text":"Second hint."}]}]}"#.data(using: .utf8)!
        XCTAssertEqual(OpenAIResponseParser.text(from: payload), "First hint.\nSecond hint.")
    }

    func testResponsesParserSupportsLegacyTopLevelField() throws {
        let payload = #"{"output_text":"Keep your method visible."}"#.data(using: .utf8)!
        XCTAssertEqual(OpenAIResponseParser.text(from: payload), "Keep your method visible.")
    }

    func testLegacyFollowUpResponsePreservesExistingWorkspace() throws {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "Explain the last step")],
            goal: "Practice algebra",
            exercise: sampleExercise,
            plan: samplePlan,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna
        )
        let payload = #"{"output_text":"Keep your method visible and check the inverse operation."}"#.data(using: .utf8)!

        let reply = try XCTUnwrap(OpenAIResponseParser.tutorReply(from: payload, preserving: request))
        XCTAssertEqual(reply.text, "Keep your method visible and check the inverse operation.")
        XCTAssertEqual(reply.plan, samplePlan)
        XCTAssertEqual(reply.exercise, sampleExercise)
    }

    func testResponsesParserDecodesStructuredPlanningEnvelope() throws {
        let payload = #"{"output":[{"type":"message","content":[{"type":"output_text","text":"{\"reply\":\"A small plan is ready.\",\"plan\":{\"title\":\"Linear confidence\",\"goal\":\"Understand a linear equation\",\"outcomes\":[\"Isolate the variable\"],\"steps\":[\"Name the inverse operation\"],\"currentStep\":0},\"exercise\":{\"title\":\"Try this\",\"prompt\":\"Solve x + 3 = 7\",\"hint\":\"Undo addition\",\"context\":\"Linear equations\"}}"}]}]}"#.data(using: .utf8)!
        let envelope = OpenAIResponseParser.planningEnvelope(from: payload)
        XCTAssertEqual(envelope?.reply, "A small plan is ready.")
        XCTAssertEqual(envelope?.plan?.title, "Linear confidence")
        XCTAssertEqual(envelope?.exercise?.prompt, "Solve x + 3 = 7")
    }

    func testResponsesParserDecodesNullablePlanningEnvelope() throws {
        let payload = #"{"output":[{"type":"message","content":[{"type":"output_text","text":"{\"reply\":\"Tell me which part feels unclear.\",\"plan\":null,\"exercise\":null}"}]}]}"#.data(using: .utf8)!
        let envelope = OpenAIResponseParser.planningEnvelope(from: payload)
        XCTAssertEqual(envelope?.reply, "Tell me which part feels unclear.")
        XCTAssertNil(envelope?.plan)
        XCTAssertNil(envelope?.exercise)
    }

    func testResponsesParserDropsMismatchedPlanningPair() throws {
        let payload = #"{"output":[{"type":"message","content":[{"type":"output_text","text":"{\"reply\":\"I can help.\",\"plan\":{\"title\":\"Algebra\",\"goal\":\"Understand equations\",\"outcomes\":[],\"steps\":[],\"currentStep\":0},\"exercise\":null}"}]}]}"#.data(using: .utf8)!
        let envelope = OpenAIResponseParser.planningEnvelope(from: payload)
        XCTAssertEqual(envelope?.reply, "I can help.")
        XCTAssertNil(envelope?.plan)
        XCTAssertNil(envelope?.exercise)
    }

    func testLivePlanningFallbackDoesNotInventPlanOrExercise() {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "I want to learn geometry")],
            goal: "I want to learn geometry",
            exercise: nil,
            plan: nil,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .sol
        )
        let reply = OpenAITutorService.fallbackPlanningReply(for: request)
        XCTAssertNil(reply.plan)
        XCTAssertNil(reply.exercise)
        XCTAssertTrue(reply.text.lowercased().contains("geometry"))
        XCTAssertFalse(reply.text.lowercased().contains("radical"))
    }

    func testTutorPromptPolicyProtectsSocraticTeaching() {
        let policy = TutorPromptPolicy.system.lowercased()
        XCTAssertTrue(policy.contains("across all areas of mathematics"))
        XCTAssertTrue(policy.contains("explain, solve, check work, or chat directly"))
        XCTAssertTrue(policy.contains("do not force socratic questions"))
        XCTAssertTrue(policy.contains("plan and board exercise together"))
        XCTAssertTrue(policy.contains("set both to null"))
        XCTAssertTrue(policy.contains("whiteboard screenshots"))
        XCTAssertTrue(policy.contains("never invent image content"))
        XCTAssertTrue(policy.contains("readable unicode/plain-text math"))
        XCTAssertFalse(policy.contains("radical"))
    }

    func testDemoFlowStaysGenericAndTreatsDontKnowAsSignal() async throws {
        let service = DemoTutorService()
        let initial = TutorRequest(messages: [TutorMessage(role: .learner, text: "I want to learn algebra")], goal: "I want to learn algebra", exercise: nil, plan: nil, imageData: nil, imageRegionDescription: nil, signal: nil, model: .sol)
        let planned = try await service.respond(to: initial)
        XCTAssertNil(planned.plan)
        XCTAssertNil(planned.exercise)
        XCTAssertTrue(planned.text.lowercased().contains("exact problem"))
        XCTAssertFalse(planned.text.lowercased().contains("radical"))

        let dontKnow = TutorRequest(messages: initial.messages, goal: initial.goal, exercise: sampleExercise, plan: samplePlan, imageData: nil, imageRegionDescription: nil, signal: .dontKnow, model: .sol)
        let reply = try await service.respond(to: dontKnow)
        XCTAssertTrue(reply.text.lowercased().contains("useful signal"))
        XCTAssertEqual(reply.plan, samplePlan)
        XCTAssertEqual(reply.exercise, sampleExercise)
    }

    func testDemoAnswersDirectMathQuestionWithoutInventingWorkspace() async throws {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "What is 2 + 2?")],
            goal: "What is 2 + 2?",
            exercise: nil,
            plan: nil,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna
        )
        let reply = try await DemoTutorService().respond(to: request)
        XCTAssertNil(reply.plan)
        XCTAssertNil(reply.exercise)
        XCTAssertFalse(reply.text.lowercased().contains("radical"))
    }

    func testSessionRoundTripsDrawingAndMessages() throws {
        var session = LearningSession.empty
        session.plan = samplePlan
        session.exercise = sampleExercise
        session.messages = [TutorMessage(role: .tutor, text: "hello")]
        session.drawingData = Data([0, 1, 2, 3])
        let data = try JSONEncoder().encode(session)
        let decoded = try JSONDecoder().decode(LearningSession.self, from: data)
        XCTAssertEqual(decoded, session)
    }

    #if DEBUG
    func testE2EFixtureContainsVectorInkWithUsefulBounds() throws {
        let drawing = E2ESeedFixture.drawing()
        XCTAssertGreaterThanOrEqual(drawing.strokes.count, 50)
        XCTAssertGreaterThan(drawing.dataRepresentation().count, 1_000)
        XCTAssertGreaterThan(drawing.bounds.width, 400)
        XCTAssertGreaterThan(drawing.bounds.height, 300)

        var session = LearningSession.empty
        E2ESeedFixture.seedSession(&session)
        XCTAssertEqual(session.plan, .radicalEquation)
        XCTAssertEqual(session.exercise, .radicalEquation)
        let seededData = try XCTUnwrap(session.drawingData)
        let seededDrawing = try? PKDrawing(data: seededData)
        XCTAssertEqual(seededDrawing?.strokes.count, drawing.strokes.count)
        XCTAssertGreaterThan(seededDrawing?.bounds.width ?? 0, 400)
        XCTAssertNotNil(seededDrawing)
    }
    #endif

    @MainActor
    func testStartWorkingDoesNotInventMissingWorkspaceContent() {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        store.startWorking()
        XCTAssertFalse(store.isWorkspace)
        XCTAssertNil(store.session.plan)
        XCTAssertNil(store.session.exercise)
        XCTAssertTrue(store.errorMessage?.contains("has not prepared") == true)
    }

    @MainActor
    func testStoreGuardsRequestsWhenAPIKeyIsMissing() {
        let keychain = KeychainStore()
        keychain.removeAPIKey()
        let router = TutorServiceRouter(apiKeyReader: { nil })
        let store = TutorStore(service: router, keychain: keychain)
        store.resetSession()
        XCTAssertTrue(store.requiresAPIKey)

        store.send("Explain fractions")

        XCTAssertEqual(store.session.messages.count, 1)
        XCTAssertTrue(store.errorMessage?.contains("Add an OpenAI API key") == true)
    }

    func testTutorPanelLayoutClampsResizeToMinimumAndAvailableBounds() {
        let available = CGSize(width: 1_024, height: 768)
        let minimum = TutorPanelLayout.minimumExpandedSize
        let maximum = CGSize(width: available.width - 38, height: available.height - 16 - 210)

        let tooSmall = TutorPanelLayout.resized(
            from: TutorPanelLayout.defaultExpandedSize,
            translation: CGSize(width: -1_000, height: -1_000),
            corner: .bottomTrailing,
            in: available,
            bottomInset: 210,
            topInset: 16
        )
        XCTAssertEqual(tooSmall.width, minimum.width)
        XCTAssertEqual(tooSmall.height, minimum.height)

        let tooLarge = TutorPanelLayout.resized(
            from: TutorPanelLayout.defaultExpandedSize,
            translation: CGSize(width: 1_000, height: 1_000),
            corner: .bottomTrailing,
            in: available,
            bottomInset: 210,
            topInset: 16
        )
        XCTAssertEqual(tooLarge.width, maximum.width)
        XCTAssertEqual(tooLarge.height, maximum.height)
    }

    func testTutorPanelLayoutClampsOffsetToVisibleRegion() {
        let available = CGSize(width: 1_024, height: 768)
        let panelSize = TutorPanelLayout.defaultExpandedSize
        let visible = TutorPanelLayout.visibleRect(in: available, bottomInset: 210)
        let anchor = TutorPanelLayout.anchor(in: available, bottomInset: 210)

        let topLeftOffset = TutorPanelLayout.clampedOffset(
            CGSize(width: -9_999, height: -9_999),
            panelSize: panelSize,
            visibleRect: visible,
            anchor: anchor
        )
        let topLeftOrigin = CGPoint(
            x: anchor.x - panelSize.width + topLeftOffset.width,
            y: anchor.y - panelSize.height + topLeftOffset.height
        )
        XCTAssertEqual(topLeftOrigin.x, visible.minX)
        XCTAssertEqual(topLeftOrigin.y, visible.minY)

        let bottomRightOffset = TutorPanelLayout.clampedOffset(
            CGSize(width: 9_999, height: 9_999),
            panelSize: panelSize,
            visibleRect: visible,
            anchor: anchor
        )
        let bottomRightOrigin = CGPoint(
            x: anchor.x - panelSize.width + bottomRightOffset.width,
            y: anchor.y - panelSize.height + bottomRightOffset.height
        )
        XCTAssertEqual(bottomRightOrigin.x + panelSize.width, visible.maxX)
        XCTAssertEqual(bottomRightOrigin.y + panelSize.height, visible.maxY)
    }

    func testTutorPanelResizeKeepsOppositeCornerFixedAndDraggedCornerTracksTranslation() {
        let available = CGSize(width: 1_024, height: 768)
        let startSize = TutorPanelLayout.defaultExpandedSize
        let startOffset = CGSize(width: -80, height: -80)
        let translation = CGSize(width: 20, height: 15)
        let bottomInset: CGFloat = 210
        let topInset: CGFloat = 16
        let anchor = TutorPanelLayout.anchor(in: available, bottomInset: bottomInset)

        func point(
            for corner: TutorPanelResizeCorner,
            size: CGSize,
            offset: CGSize
        ) -> CGPoint {
            let origin = CGPoint(
                x: anchor.x - size.width + offset.width,
                y: anchor.y - size.height + offset.height
            )
            switch corner {
            case .topLeading: return origin
            case .topTrailing: return CGPoint(x: origin.x + size.width, y: origin.y)
            case .bottomLeading: return CGPoint(x: origin.x, y: origin.y + size.height)
            case .bottomTrailing: return CGPoint(x: origin.x + size.width, y: origin.y + size.height)
            }
        }

        func opposite(of corner: TutorPanelResizeCorner) -> TutorPanelResizeCorner {
            switch corner {
            case .topLeading: return .bottomTrailing
            case .topTrailing: return .bottomLeading
            case .bottomLeading: return .topTrailing
            case .bottomTrailing: return .topLeading
            }
        }

        for corner in TutorPanelResizeCorner.allCases {
            let result = TutorPanelLayout.resizedLayout(
                from: startSize,
                startOffset: startOffset,
                translation: translation,
                corner: corner,
                in: available,
                bottomInset: bottomInset,
                topInset: topInset
            )
            let startPoint = point(for: corner, size: startSize, offset: startOffset)
            let endPoint = point(for: corner, size: result.size, offset: result.offset)
            XCTAssertEqual(endPoint.x, startPoint.x + translation.width, accuracy: 0.001, "(corner) handle should track horizontal drag")
            XCTAssertEqual(endPoint.y, startPoint.y + translation.height, accuracy: 0.001, "(corner) handle should track vertical drag")

            let oppositeStart = point(for: opposite(of: corner), size: startSize, offset: startOffset)
            let oppositeEnd = point(for: opposite(of: corner), size: result.size, offset: result.offset)
            XCTAssertEqual(oppositeEnd.x, oppositeStart.x, accuracy: 0.001, "(corner) resize should preserve opposite corner horizontally")
            XCTAssertEqual(oppositeEnd.y, oppositeStart.y, accuracy: 0.001, "(corner) resize should preserve opposite corner vertically")
        }
    }

    private static let samplePlan = SessionPlan(
        title: "Algebra confidence",
        goal: "Understand one equation",
        outcomes: ["Choose a reversible operation"],
        steps: ["Name the operation", "Check the result"],
        currentStep: 0
    )

    private static let sampleExercise = Exercise(
        title: "Try this",
        prompt: "Solve x + 3 = 7",
        hint: "Undo the addition",
        context: "A short algebra check"
    )

    private var samplePlan: SessionPlan { Self.samplePlan }
    private var sampleExercise: Exercise { Self.sampleExercise }

    @MainActor
    private func configuredCanvas() -> PKCanvasView {
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        PencilCanvasConfiguration.configure(canvas, viewport: canvas.bounds.size)
        // These tests assert on rasterization, not on where a session starts, so
        // they view the board's top-left corner and place ink there. Tests that
        // care about the centered start position set their own offset.
        canvas.contentOffset = .zero
        return canvas
    }

    private func makeDrawing(color: UIColor, origin: CGPoint = CGPoint(x: 120, y: 250)) -> PKDrawing {
        let ink = PKInk(.pen, color: color)
        let points = [
            CGPoint(x: origin.x, y: origin.y),
            CGPoint(x: origin.x + 40, y: origin.y),
            CGPoint(x: origin.x + 40, y: origin.y + 50),
            CGPoint(x: origin.x, y: origin.y + 50),
            CGPoint(x: origin.x, y: origin.y)
        ]
        let controlPoints = points.enumerated().map { index, point in
            PKStrokePoint(
                location: point,
                timeOffset: Double(index) * 0.02,
                size: CGSize(width: 8, height: 8),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let path = PKStrokePath(controlPoints: controlPoints, creationDate: Date(timeIntervalSinceReferenceDate: 0))
        let stroke = PKStroke(ink: ink, path: path, transform: .identity, mask: nil, randomSeed: 13)
        return PKDrawing(strokes: [stroke])
    }

    private struct PixelStats {
        var darkPixelCount: Int
        var nonWhitePixelCount: Int
    }

    private func pixelStats(for data: Data) throws -> PixelStats {
        let image = try XCTUnwrap(UIImage(data: data)?.cgImage)
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        let context = try XCTUnwrap(CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        var darkPixelCount = 0
        var nonWhitePixelCount = 0
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let red = Int(pixels[index])
            let green = Int(pixels[index + 1])
            let blue = Int(pixels[index + 2])
            let luminance = (red + green + blue) / 3
            if luminance < 220 { darkPixelCount += 1 }
            if luminance < 250 { nonWhitePixelCount += 1 }
        }
        return PixelStats(darkPixelCount: darkPixelCount, nonWhitePixelCount: nonWhitePixelCount)
    }

    private actor SequencedStructuredTutorService: TutorService {
        var payloads: [Data]

        init(payloads: [Data]) {
            self.payloads = payloads
        }

        func respond(to request: TutorRequest) async throws -> TutorReply {
            guard !payloads.isEmpty else { throw TutorServiceError.invalidResponse }
            let payload = payloads.removeFirst()
            guard let reply = OpenAIResponseParser.tutorReply(from: payload, preserving: request) else {
                throw TutorServiceError.invalidResponse
            }
            return reply
        }
    }

    private func structuredResponsePayload(
        reply: String,
        plan: SessionPlan?,
        exercise: Exercise?
    ) throws -> Data {
        let planValue: Any = if let plan {
            try jsonObject(for: plan)
        } else {
            NSNull()
        }
        let exerciseValue: Any = if let exercise {
            try jsonObject(for: exercise)
        } else {
            NSNull()
        }
        let envelope: [String: Any] = [
            "reply": reply,
            "plan": planValue,
            "exercise": exerciseValue
        ]
        let envelopeData = try JSONSerialization.data(withJSONObject: envelope)
        let envelopeText = try XCTUnwrap(String(data: envelopeData, encoding: .utf8))
        return try JSONSerialization.data(withJSONObject: [
            "output": [[
                "type": "message",
                "content": [[
                    "type": "output_text",
                    "text": envelopeText
                ]]
            ]]
        ])
    }

    private func jsonObject<T: Encodable>(for value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor
    private func waitForTutorRequest(on store: TutorStore) async throws {
        for _ in 0..<100 {
            if !store.isLoading { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Tutor request did not finish within the test timeout")
    }

    private func responseBodyJSON(for request: TutorRequest) throws -> [String: Any] {
        let body = OpenAITutorService.requestBody(for: request)
        let data = try JSONSerialization.data(withJSONObject: body)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
