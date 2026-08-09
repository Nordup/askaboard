import XCTest
@testable import MathTutor

@MainActor
final class ComposerAttachmentsTests: XCTestCase {
    func testAChipAppearsImmediatelyAndUploadingIsItsFirstState() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            try await Task.sleep(nanoseconds: 50_000_000)
            return .stub()
        })

        attachments.add(data: Data(), filename: "worksheet.pdf",
                        contentType: "application/pdf", sessionID: UUID())

        XCTAssertEqual(attachments.pending.count, 1)
        XCTAssertEqual(attachments.pending[0].filename, "worksheet.pdf")
        XCTAssertEqual(attachments.pending[0].state, .uploading)
    }

    func testAFinishedUploadBecomesReady() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in .stub() })

        attachments.add(data: Data(), filename: "worksheet.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        _ = await attachments.readyForSend()

        guard case .ready = attachments.pending[0].state else {
            return XCTFail("expected .ready, got \(attachments.pending[0].state)")
        }
    }

    func testAReadyForSendWaitsForAnUploadStillInFlight() async {
        // The learner hits send while a six-page PDF is still converting. The
        // attachment must not be dropped.
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            try await Task.sleep(nanoseconds: 100_000_000)
            return .stub()
        })

        attachments.add(data: Data(), filename: "slow.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        let ready = await attachments.readyForSend()

        XCTAssertEqual(ready.count, 1)
    }

    func testAFailedUploadKeepsTheServersSentenceOnTheChip() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            throw TutorServiceError.network("I can’t read mystery.bin.")
        })

        attachments.add(data: Data(), filename: "mystery.bin",
                        contentType: "application/octet-stream", sessionID: UUID())
        _ = await attachments.readyForSend()

        XCTAssertEqual(attachments.pending[0].state, .failed("I can’t read mystery.bin."))
    }

    func testAFailedAttachmentIsNotSent() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            throw TutorServiceError.network("nope")
        })

        attachments.add(data: Data(), filename: "mystery.bin",
                        contentType: "application/octet-stream", sessionID: UUID())

        let ready = await attachments.readyForSend()
        XCTAssertTrue(ready.isEmpty)
    }

    func testRemovingAChipTakesItOutOfTheRow() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in .stub() })
        attachments.add(data: Data(), filename: "a.pdf",
                        contentType: "application/pdf", sessionID: UUID())

        attachments.remove(attachments.pending[0].id)

        XCTAssertTrue(attachments.pending.isEmpty)
    }

    func testTheRowFillsAtTheCap() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in .stub() })
        for index in 0..<ComposerAttachments.limit {
            attachments.add(data: Data(), filename: "\(index).pdf",
                            contentType: "application/pdf", sessionID: UUID())
        }

        XCTAssertTrue(attachments.isFull)

        attachments.add(data: Data(), filename: "one-too-many.pdf",
                        contentType: "application/pdf", sessionID: UUID())

        XCTAssertEqual(attachments.pending.count, ComposerAttachments.limit)
    }

    func testRemovingDuringReadyForSendExcludesItFromWhatIsSent() async {
        // A learner who removes a chip mid-upload — while a concurrent send is
        // already awaiting it — must not have that attachment appear in the
        // batch that goes out. `readyForSend()` reads `pending` fresh only
        // after every in-flight task resolves, so a removal that lands during
        // the wait has to be reflected in the result, not just in the array
        // you'd see afterward.
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            try await Task.sleep(nanoseconds: 100_000_000)
            return .stub()
        })

        attachments.add(data: Data(), filename: "keep.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        attachments.add(data: Data(), filename: "remove-me.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        let removeID = attachments.pending[1].id

        async let ready = attachments.readyForSend()
        try? await Task.sleep(nanoseconds: 20_000_000)
        attachments.remove(removeID)

        let result = await ready
        XCTAssertEqual(result.count, 1)
        XCTAssertTrue(attachments.pending.allSatisfy { $0.id != removeID })
    }
}

private extension UploadedAttachment {
    static func stub() -> UploadedAttachment {
        UploadedAttachment(
            attachment: MessageAttachment(
                id: UUID(), filename: "worksheet.pdf", kind: "pdf", pageCount: 1
            ),
            thumbnail: Data("thumb".utf8)
        )
    }
}
