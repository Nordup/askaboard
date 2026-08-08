import Foundation
import XCTest
@testable import MathTutor

final class BoardSceneTests: XCTestCase {
    func testBoardElementRoundTripsThroughWireJSON() throws {
        let scene = BoardScene(elements: [
            .text(TextElement(
                id: "title",
                x: 10,
                y: 20,
                text: "Hello\nworld",
                fontSize: 36,
                alignment: .center,
                width: 300,
                style: BoardStyle(
                    role: .emphasis,
                    stroke: "#0155FB",
                    fill: "transparent",
                    strokeWidth: 2,
                    opacity: 0.9,
                    dash: [6, 4],
                    rotation: 15
                )
            )),
            .polygon(PolygonElement(
                id: "tri",
                points: [
                    BoardPoint(x: 0, y: 0),
                    BoardPoint(x: 100, y: 0),
                    BoardPoint(x: 50, y: 80),
                ],
                style: BoardStyle()
            )),
        ])

        let data = try JSONEncoder().encode(scene)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let elements = try XCTUnwrap(json["elements"] as? [[String: Any]])
        XCTAssertEqual(elements.count, 2)
        XCTAssertEqual(elements[0]["kind"] as? String, "text")
        XCTAssertEqual(elements[0]["stroke_width"] as? Double, 2)
        XCTAssertEqual(elements[1]["kind"] as? String, "polygon")
        let points = try XCTUnwrap(elements[1]["points"] as? [[Double]])
        XCTAssertEqual(points, [[0, 0], [100, 0], [50, 80]])

        let restored = try JSONDecoder().decode(BoardScene.self, from: data)
        XCTAssertEqual(restored, scene)
    }

    func testApplySemanticsAreReplaceDeleteThenIdempotentUpsert() {
        let original = BoardScene(elements: [
            .text(TextElement(id: "keep", x: 0, y: 0, text: "a", fontSize: 20, alignment: .left, width: 0, style: BoardStyle())),
            .text(TextElement(id: "old", x: 1, y: 1, text: "b", fontSize: 20, alignment: .left, width: 0, style: BoardStyle())),
        ])

        let updated = original.applying(BoardSceneUpdate(
            upserts: [
                .text(TextElement(id: "keep", x: 5, y: 5, text: "revised", fontSize: 30, alignment: .left, width: 0, style: BoardStyle())),
                .text(TextElement(id: "new", x: 2, y: 2, text: "c", fontSize: 20, alignment: .left, width: 0, style: BoardStyle())),
            ],
            deletes: ["old"],
            replaceAll: false
        ))

        XCTAssertEqual(updated.elements.map(\.id), ["keep", "new"])
        if case .text(let value) = updated.elements[0] {
            XCTAssertEqual(value.text, "revised")
            XCTAssertEqual(value.fontSize, 30)
        } else {
            XCTFail("keep should be replaced in place")
        }
    }

    func testReplaceAllClearsBeforeApplying() {
        let original = BoardScene(elements: [
            .line(LineElement(id: "one", x1: 0, y1: 0, x2: 1, y2: 1, style: BoardStyle()))
        ])
        let result = original.applying(BoardSceneUpdate(
            upserts: [
                .circle(CircleElement(id: "two", cx: 5, cy: 5, radius: 3, style: BoardStyle()))
            ],
            deletes: ["unused"],
            replaceAll: true
        ))
        XCTAssertEqual(result.elements.map(\.id), ["two"])
    }

    func testDuplicateIDsInOneBatchResolveToTheLastValue() {
        let original = BoardScene.empty
        let result = original.applying(BoardSceneUpdate(
            upserts: [
                .text(TextElement(id: "x", x: 0, y: 0, text: "first", fontSize: 20, alignment: .left, width: 0, style: BoardStyle())),
                .text(TextElement(id: "x", x: 1, y: 1, text: "second", fontSize: 30, alignment: .left, width: 0, style: BoardStyle())),
            ],
            deletes: [],
            replaceAll: false
        ))
        XCTAssertEqual(result.elements.count, 1)
        if case .text(let value) = result.elements[0] {
            XCTAssertEqual(value.text, "second")
        } else {
            XCTFail("duplicate id should resolve to the last value")
        }
    }

    func testLearningSessionWithoutBoardSceneDecodesToEmpty() throws {
        var session = LearningSession.empty
        session.boardScene = E2ESeedFixture.scene()
        let data = try JSONEncoder().encode(session)
        var json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        json.removeValue(forKey: "boardScene")
        let oldData = try JSONSerialization.data(withJSONObject: json)

        let restored = try JSONDecoder().decode(LearningSession.self, from: oldData)
        XCTAssertEqual(restored.boardScene, .empty)
    }

    func testTutorEventDecodesBoardUpdate() {
        let line = """
        data: {"type":"board_update","payload":{"upserts":[{"id":"a","kind":"line","x1":0,"y1":0,"x2":100,"y2":0,"role":"content","stroke":"#0A0A0A","fill":"transparent","stroke_width":4,"opacity":1,"dash":[],"rotation":0}],"deletes":["old"],"replace_all":true}}
        """
        guard case .boardUpdate(let update)? = TutorEvent.decode(from: line) else {
            return XCTFail("Expected a boardUpdate event")
        }
        XCTAssertEqual(update.deletes, ["old"])
        XCTAssertTrue(update.replaceAll)
        XCTAssertEqual(update.upserts.first?.id, "a")
        XCTAssertEqual(update.upserts.first?.kind, .line)
    }

    func testBoardSceneAppliesTheActualServerPayloadShape() {
        let original = BoardScene(elements: [
            .text(TextElement(id: "old", x: 1, y: 1, text: "b", fontSize: 20, alignment: .left, width: 0, style: BoardStyle())),
            .text(TextElement(id: "keep", x: 2, y: 2, text: "a", fontSize: 20, alignment: .left, width: 0, style: BoardStyle())),
        ])
        let payloadJSON = """
        {"upserts":[{"id":"keep","kind":"text","x":10,"y":10,"text":"revised","font_size":32,"alignment":"right","width":200,"role":"content","stroke":"#0A0A0A","fill":"transparent","stroke_width":1,"opacity":1,"dash":[],"rotation":0},{"id":"new","kind":"circle","cx":5,"cy":6,"radius":7,"role":"content","stroke":"#0A0A0A","fill":"transparent","stroke_width":4,"opacity":1,"dash":[],"rotation":0}],"deletes":["old"],"replace_all":false}
        """
        let update = try! JSONDecoder().decode(
            BoardSceneUpdate.self,
            from: Data(payloadJSON.utf8)
        )
        let applied = original.applying(update)

        XCTAssertEqual(applied.elements.map(\.id), ["keep", "new"])
        if case .text(let value) = applied.elements[0] {
            XCTAssertEqual(value.text, "revised")
            XCTAssertEqual(value.fontSize, 32)
        } else {
            XCTFail("replace-in-place should preserve z-order")
        }
    }

    func testRequestBodyCarriesBoardScene() {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "draw it")],
            goal: nil,
            exercise: nil,
            plan: nil,
            imageData: nil,
            imageRegionDescription: nil,
            boardScene: #"{"kind":"board_scene_context"}"#,
            signal: nil,
            sessionID: UUID(),
            model: .sol
        )
        let body = BackendTutorService.body(for: request)
        XCTAssertEqual(body["board_scene"] as? String, #"{"kind":"board_scene_context"}"#)
    }

    @MainActor
    func testTutorSceneFixtureIsNonEmptyAndRich() {
        let scene = E2ESeedFixture.scene()
        XCTAssertFalse(scene.elements.isEmpty)
        let kinds = Set(scene.elements.map(\.kind))
        XCTAssertEqual(kinds, Set(BoardElementKind.allCases))
        let roles = Set(scene.elements.map(\.style.role))
        XCTAssertTrue(roles.isSuperset(of: [.content, .hint, .correction, .emphasis]))

        let origin = PencilCanvasConfiguration.boardOrigin
        let bounds = try! XCTUnwrap(BoardSceneRenderer.bounds(of: scene, boardOrigin: origin))
        XCTAssertGreaterThanOrEqual(bounds.minX, origin.x - 500)
        XCTAssertLessThanOrEqual(bounds.maxX, origin.x + 500)
        XCTAssertGreaterThanOrEqual(bounds.minY, origin.y - 350)
        XCTAssertLessThanOrEqual(bounds.maxY, origin.y + 350)
    }
}

@MainActor
final class BoardSceneStoreTests: XCTestCase {
    func testStoreAppliesBoardUpdateAndPersistsAtDone() async throws {
        let update = BoardSceneUpdate(
            mode: .upsert,
            deleteIDs: [],
            elements: [
                .text(TextElement(id: "note", x: 0, y: 0, text: "drawn", fontSize: 40, alignment: .left, width: 0, style: BoardStyle()))
            ]
        )
        let store = TutorStore(
            service: ScriptedTutorService(events: [
                .boardUpdate(update), .textDelta("I drew it."), .done,
            ]),
            persistence: .inMemory,
            configuration: .stub
        )

        await store.sendAndWait("draw something")

        XCTAssertEqual(store.session.boardScene.elements.map(\.id), ["note"])
        let saved = try XCTUnwrap(SessionPersistence(fileURL: store.persistence.fileURL).load())
        XCTAssertEqual(saved.boardScene.elements.map(\.id), ["note"])
    }

    func testStorePersistsAppliedSceneWhenTheTurnFails() async throws {
        let update = BoardSceneUpdate(
            upserts: [
                .circle(CircleElement(id: "c", cx: 0, cy: 0, radius: 50, style: BoardStyle()))
            ],
            deletes: [],
            replaceAll: false
        )
        let store = TutorStore(
            service: ScriptedTutorService(events: [
                .boardUpdate(update), .failure(message: "stream died", retryable: true),
            ]),
            persistence: .inMemory,
            configuration: .stub
        )

        await store.sendAndWait("draw")

        XCTAssertEqual(store.session.boardScene.elements.map(\.id), ["c"])
        XCTAssertEqual(store.errorMessage, "stream died")
        let saved = try XCTUnwrap(SessionPersistence(fileURL: store.persistence.fileURL).load())
        XCTAssertEqual(saved.boardScene.elements.map(\.id), ["c"])
    }
}
