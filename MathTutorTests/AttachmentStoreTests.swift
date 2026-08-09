import XCTest
@testable import MathTutor

final class AttachmentStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testAThumbnailSurvivesBeingWrittenAndReadBack() {
        let store = AttachmentStore(directoryURL: directory)
        let id = UUID()

        store.save(Data("jpeg-bytes".utf8), for: id, in: UUID())

        XCTAssertEqual(store.thumbnail(for: id), Data("jpeg-bytes".utf8))
    }

    func testAMissingThumbnailIsNilRatherThanACrash() {
        let store = AttachmentStore(directoryURL: directory)
        XCTAssertNil(store.thumbnail(for: UUID()))
    }

    func testDeletingASessionTakesItsThumbnailsWithIt() {
        let store = AttachmentStore(directoryURL: directory)
        let sessionID = UUID()
        let id = UUID()
        store.save(Data("jpeg-bytes".utf8), for: id, in: sessionID)

        store.deleteAll(for: sessionID)

        XCTAssertNil(store.thumbnail(for: id))
    }

    func testDeletingOneSessionLeavesAnothersThumbnailsAlone() {
        let store = AttachmentStore(directoryURL: directory)
        let doomed = UUID()
        let survivor = UUID()
        let dropped = UUID()
        let kept = UUID()
        store.save(Data("drop-me".utf8), for: dropped, in: doomed)
        store.save(Data("keep-me".utf8), for: kept, in: survivor)

        store.deleteAll(for: doomed)

        XCTAssertNil(store.thumbnail(for: dropped))
        XCTAssertEqual(store.thumbnail(for: kept), Data("keep-me".utf8))
    }

    func testAMessageWithAttachmentsRoundTripsThroughCoding() throws {
        let message = TutorMessage(
            role: .learner,
            text: "here's my homework",
            attachments: [MessageAttachment(
                id: UUID(), filename: "worksheet.pdf", kind: "pdf", pageCount: 3
            )]
        )

        let decoded = try JSONDecoder().decode(
            TutorMessage.self, from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(decoded.attachments, message.attachments)
    }

    func testAMessageStoredBeforeAttachmentsExistedStillDecodes() throws {
        // Every session already on disk was written without this key.
        let legacy = Data("""
        {"id":"\(UUID().uuidString)","role":"learner","text":"hi",
         "createdAt":0}
        """.utf8)

        let decoded = try JSONDecoder().decode(TutorMessage.self, from: legacy)

        XCTAssertEqual(decoded.attachments, [])
    }
}
