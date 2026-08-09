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
        //
        // This test was independently reviewed for whether it would actually
        // fail a filter-instead-of-await regression, and confirmed to: `add()`
        // enqueues the upload as a MainActor job, and a `readyForSend()` with
        // no internal `await` never yields the actor, so a filtering
        // implementation would return before that job ever ran, seeing
        // `.uploading` and reporting `ready.count == 0`. One sleep, no race
        // against a second duration, so it's left as the brief wrote it.
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

    /// A learner removes a chip mid-upload while a send is already awaiting
    /// it. That attachment must not appear in what gets sent.
    ///
    /// Gated on `UploadGate` rather than two racing sleep durations (an
    /// earlier version of this test raced a ~20ms remove against a ~100ms
    /// upload — a 5x margin, but still a clock bet). `isSending` flips to
    /// `true` as `readyForSend()`'s first statement, before its own first
    /// `await`, so spinning on it with `Task.yield()` is a condition wait,
    /// not a timing guess: it can only stop once `readyForSend()` has
    /// actually snapshotted both attachments as part of this send, however
    /// many yields that takes.
    func testRemovingDuringReadyForSendExcludesItFromWhatIsSent() async {
        let gate = UploadGate()
        let attachments = ComposerAttachments(upload: { _, filename, _, _ in
            await gate.wait(for: filename)
            return .stub(filename: filename)
        })

        attachments.add(data: Data(), filename: "keep.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        attachments.add(data: Data(), filename: "remove-me.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        let removeID = attachments.pending[1].id

        async let result = attachments.readyForSend()
        while !attachments.isSending { await Task.yield() }

        attachments.remove(removeID)
        await gate.open("keep.pdf")
        // The cancelled task is still parked in `gate.wait` — resume it too so
        // it finishes cleanly instead of leaking for the rest of the run. Its
        // outcome no longer matters: `update` no-ops once the id is gone from
        // `pending`.
        await gate.open("remove-me.pdf")

        let sent = await result
        XCTAssertEqual(sent.count, 1)
        XCTAssertTrue(attachments.pending.allSatisfy { $0.id != removeID })
    }

    /// While a send is in flight, the composer refuses new attachments
    /// outright rather than merely excluding them afterward — a file picked
    /// mid-send belongs to the next message, and the caller clears the draft
    /// the moment this send returns, so there would be nowhere for it to land.
    func testAddDuringAnInFlightSendIsRefused() async {
        let gate = UploadGate()
        let attachments = ComposerAttachments(upload: { _, filename, _, _ in
            await gate.wait(for: filename)
            return .stub(filename: filename)
        })

        attachments.add(data: Data(), filename: "first.pdf",
                        contentType: "application/pdf", sessionID: UUID())

        async let result = attachments.readyForSend()
        while !attachments.isSending { await Task.yield() }

        attachments.add(data: Data(), filename: "too-late.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        XCTAssertEqual(attachments.pending.count, 1)
        XCTAssertEqual(attachments.pending[0].filename, "first.pdf")

        await gate.open("first.pdf")
        _ = await result
    }

    /// The result of a send is exactly the draft as it stood when send was
    /// tapped — a slow attachment and a fast one both belong to it, whichever
    /// order they actually finish in.
    func testSendReturnsExactlyTheDraftThatExistedAtCallTime() async {
        let gate = UploadGate()
        let attachments = ComposerAttachments(upload: { _, filename, _, _ in
            await gate.wait(for: filename)
            return .stub(filename: filename)
        })

        attachments.add(data: Data(), filename: "slow.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        attachments.add(data: Data(), filename: "fast.pdf",
                        contentType: "application/pdf", sessionID: UUID())

        async let result = attachments.readyForSend()

        // Resolve out of order — the second-added attachment finishes first —
        // to prove the result is the set that existed at call time, not an
        // artifact of resolution order.
        await gate.open("fast.pdf")
        await gate.open("slow.pdf")

        let sent = await result
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(Set(sent.map(\.attachment.filename)), ["slow.pdf", "fast.pdf"])
    }

    // MARK: - What a send leaves behind

    /// **A send clears what it sent, and only that.** Attach a worksheet the server
    /// refuses and a photo it takes, hit send: the turn goes with the photo, and the
    /// refused chip has to still be there with its sentence. `clear()` used to run here
    /// and took it with them, so the file that failed vanished along with the only
    /// account of why.
    func testASendClearsWhatWentAndKeepsWhatDidNot() async {
        let attachments = ComposerAttachments(upload: { _, filename, _, _ in
            guard filename == "photo.heic" else {
                throw TutorServiceError.network("\(filename) is larger than 25MB.")
            }
            return .stub(filename: filename)
        })

        attachments.add(data: Data(), filename: "worksheet.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        attachments.add(data: Data(), filename: "photo.heic",
                        contentType: "image/heic", sessionID: UUID())

        let sent = await attachments.readyForSend()
        XCTAssertEqual(sent.map(\.attachment.filename), ["photo.heic"])

        attachments.clearSent()

        XCTAssertEqual(
            attachments.pending.map(\.filename),
            ["worksheet.pdf"],
            "A refused chip is the learner's to remove — a successful send must not do it for them"
        )
        XCTAssertEqual(
            attachments.failureNote,
            "worksheet.pdf is larger than 25MB.",
            "The sentence above the pill is the whole explanation, and it goes with the chip"
        )
    }

    /// A session switch is the other case, and it still takes everything: the chips were
    /// uploaded against a session id the new session's turn has no claim on.
    func testASessionSwitchStillClearsFailedChipsToo() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            throw TutorServiceError.network("nope")
        })

        attachments.add(data: Data(), filename: "mystery.bin",
                        contentType: "application/octet-stream", sessionID: UUID())
        _ = await attachments.readyForSend()

        attachments.clear()

        XCTAssertTrue(attachments.isEmpty)
        XCTAssertNil(attachments.failureNote)
    }

    // MARK: - Refused before it was ever read

    /// The Files picker's size check cannot go through `add` — the whole point is that it
    /// answers before the bytes are read — so it lands here instead. What the learner sees
    /// must be indistinguishable from a server refusal: same failed chip, same sentence in
    /// the note line, same ✕.
    func testAFileRefusedBeforeReadingLooksExactlyLikeAServerRefusal() {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in .stub() })
        let sentence = AttachmentUploader.tooLargeSentence(filename: "lecture.mov")

        attachments.refuse(filename: "lecture.mov", sentence: sentence)

        XCTAssertEqual(attachments.pending.map(\.filename), ["lecture.mov"])
        XCTAssertEqual(attachments.pending[0].state, .failed(sentence))
        XCTAssertEqual(attachments.failureNote, sentence)
    }

    /// The cap the device declines on is the server's, restated once — and the sentence is
    /// the server's too, word for word (`upload_attachment` in
    /// `server/app/api/attachments.py`). A learner must not be able to tell which side of
    /// the wire turned their file down.
    func testTheClientSideCapAndItsSentenceMirrorTheEndpoint() {
        XCTAssertEqual(AttachmentUploader.maxBytes, 25 * 1024 * 1024)
        XCTAssertEqual(
            AttachmentUploader.tooLargeSentence(filename: "lecture.mov"),
            "lecture.mov is larger than 25MB. Try a photo of just the part you need."
        )
    }

    // MARK: - The menu row to the picker

    /// Three cases, one line each, and nothing in the type system stops two of them being
    /// swapped: `AttachmentSource(.camera)` returning `.files` opens the wrong picker with
    /// the whole suite green. The map is exhaustive on `AttachMenuChoice`, so a fourth menu
    /// row fails to compile here rather than silently opening a photo library.
    func testEveryMenuRowOpensItsOwnPicker() {
        XCTAssertEqual(AttachmentSource(.photoLibrary), .photoLibrary)
        XCTAssertEqual(AttachmentSource(.camera), .camera)
        XCTAssertEqual(AttachmentSource(.files), .files)
        XCTAssertEqual(
            Set(AttachMenuChoice.allCases.map { AttachmentSource($0) }).count,
            AttachMenuChoice.allCases.count,
            "Two rows mapping to one picker would leave a row that never opens anything"
        )
    }
}

/// Lets a test hold an injected upload closure open until it explicitly says
/// to finish — an actor, so it's `Sendable` and safe to capture in the
/// `@Sendable` `Upload` closure.
private actor UploadGate {
    private var continuations: [String: CheckedContinuation<Void, Never>] = [:]
    private var opened: Set<String> = []

    /// Called from inside the injected upload closure. Suspends until `open`
    /// is called for this same key, or returns immediately if it already was.
    func wait(for key: String) async {
        if opened.contains(key) { return }
        await withCheckedContinuation { continuation in
            continuations[key] = continuation
        }
    }

    /// Called from the test. Lets the matching `wait(for:)` proceed.
    func open(_ key: String) {
        opened.insert(key)
        continuations.removeValue(forKey: key)?.resume()
    }
}

private extension UploadedAttachment {
    static func stub(filename: String = "worksheet.pdf") -> UploadedAttachment {
        UploadedAttachment(
            attachment: MessageAttachment(
                id: UUID(), filename: filename, kind: "pdf", pageCount: 1
            ),
            thumbnail: Data("thumb".utf8)
        )
    }
}
