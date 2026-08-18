import XCTest
import os
@testable import MathTutor

/// A call survives the learner switching sessions to browse.
///
/// Three things have to hold for that to be true rather than merely to look
/// true, and each is a permanent consequence if it does not:
/// - the call session's server close waits for the call (a close mid-call
///   freezes that session's one and only episode around half a conversation),
/// - a delegated turn lands in the call session and not in the one on screen
///   (a turn in the wrong thread is written into the wrong file),
/// - the pill is on screen exactly while a call is somewhere else.
@MainActor
final class VoiceCallSessionTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("MathTutorTests-voicecall-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    // MARK: - The deferred close, as a decision table

    func testSwitchingAwayWithNoCallClosesNormally() {
        var decision = DeferredSessionClose()
        let left = UUID()

        XCTAssertTrue(decision.switchingAway(from: left, callSessionID: nil))
        XCTAssertNil(decision.pendingSessionID)
    }

    func testSwitchingAwayFromALiveCallDefersTheClose() {
        var decision = DeferredSessionClose()
        let call = UUID()

        XCTAssertFalse(
            decision.switchingAway(from: call, callSessionID: call),
            "A close now would freeze the episode around half a conversation"
        )
        XCTAssertEqual(decision.pendingSessionID, call)
    }

    func testSwitchingAwayFromAnotherSessionWhileACallRunsClosesNormally() {
        var decision = DeferredSessionClose()
        let call = UUID()
        let browsing = UUID()
        _ = decision.switchingAway(from: call, callSessionID: call)

        XCTAssertTrue(
            decision.switchingAway(from: browsing, callSessionID: call),
            "The session being left holds no call; only the call session waits"
        )
        XCTAssertEqual(decision.pendingSessionID, call, "The call session still waits")
    }

    func testACallEndingAwayFromItsSessionSendsTheDeferredClose() {
        var decision = DeferredSessionClose()
        let call = UUID()
        let browsing = UUID()
        _ = decision.switchingAway(from: call, callSessionID: call)

        XCTAssertEqual(
            decision.callEnded(inSession: call, visibleSessionID: browsing), call
        )
        XCTAssertNil(decision.pendingSessionID)
    }

    func testACallEndingBackInsideItsOwnSessionClosesNothing() {
        var decision = DeferredSessionClose()
        let call = UUID()
        _ = decision.switchingAway(from: call, callSessionID: call)

        XCTAssertNil(
            decision.callEnded(inSession: call, visibleSessionID: call),
            "The learner is in that session; leaving it later is what closes it"
        )
        XCTAssertNil(decision.pendingSessionID)
    }

    func testLeavingTheCallSessionAgainLaterClosesItNormally() {
        var decision = DeferredSessionClose()
        let call = UUID()
        _ = decision.switchingAway(from: call, callSessionID: call)
        _ = decision.callEnded(inSession: call, visibleSessionID: call)

        XCTAssertTrue(decision.switchingAway(from: call, callSessionID: nil))
        XCTAssertNil(decision.pendingSessionID)
    }

    func testAnEndingReportedForASessionNothingWaitsOnClosesNothing() {
        var decision = DeferredSessionClose()

        XCTAssertNil(decision.callEnded(inSession: UUID(), visibleSessionID: UUID()))
    }

    func testADestroyedSessionDropsItsDeferredClose() {
        var decision = DeferredSessionClose()
        let call = UUID()
        _ = decision.switchingAway(from: call, callSessionID: call)

        decision.forget(call)

        XCTAssertNil(decision.pendingSessionID, "A deleted session is forgotten, never closed")
    }

    // MARK: - The deferred close, through the store

    func testTheCallSessionIsNotClosedOnTheSwitchAway() async {
        let service = ClosingSpyService()
        let store = makeStore(service)
        await store.sendAndWait("what is 2/3 + 1/4")
        store.voiceCallBegan()

        store.startNewSession()

        await settle()
        XCTAssertEqual(
            service.closed, [],
            "The call is still speaking into that transcript; closing freezes it torn"
        )
    }

    func testTheCallSessionIsClosedWhenTheCallEndsAwayFromIt() async {
        let sent = expectation(description: "close sent")
        let service = ClosingSpyService(onClose: { sent.fulfill() })
        let store = makeStore(service)
        await store.sendAndWait("what is 2/3 + 1/4")
        let call = store.session.id
        store.voiceCallBegan()
        store.startNewSession()

        store.voiceCallEnded(sessionID: call)

        await fulfillment(of: [sent], timeout: 2)
        XCTAssertEqual(service.closed, [call])
    }

    func testACallThatEndsInsideItsOwnSessionClosesNothing() async {
        let service = ClosingSpyService()
        let store = makeStore(service)
        await store.sendAndWait("what is 2/3 + 1/4")
        let call = store.session.id
        store.voiceCallBegan()

        store.voiceCallEnded(sessionID: call)

        await settle()
        XCTAssertEqual(service.closed, [], "The learner never left the session")
    }

    func testAnEndingForACallAlreadyReplacedIsIgnored() async {
        let service = ClosingSpyService()
        let store = makeStore(service)
        await store.sendAndWait("first")
        let stale = UUID()
        store.voiceCallBegan()

        store.voiceCallEnded(sessionID: stale)

        await settle()
        XCTAssertEqual(service.closed, [])
        XCTAssertEqual(
            store.callSessionID, store.session.id,
            "The live call must survive an ending reported for a call that is not it"
        )
    }

    // MARK: - A delegated turn lands in the call session

    func testADelegatedTurnLandsInTheCallSessionWhileAnotherIsVisible() async {
        let service = VoiceTurnSpyService()
        let store = makeStore(service)
        await store.sendAndWait("fractions please")
        let call = store.session.id
        store.voiceCallBegan()
        store.startNewSession()
        let visible = store.session.id

        let result = await store.runVoiceTurn(request: "explain the common denominator")

        guard case .success = result else {
            return XCTFail("The turn should have completed: \(result)")
        }
        XCTAssertEqual(
            service.requestedSessionIDs.last, call,
            "The turn goes out against the call's session, not the one on screen"
        )
        XCTAssertFalse(
            service.requestedSessionIDs.contains(visible),
            "Nothing about this turn may name the session being browsed"
        )
        XCTAssertEqual(store.session.id, visible, "The switch is not undone by the turn")
        XCTAssertTrue(
            store.session.messages.isEmpty,
            "Not one word of the away turn may reach the thread being browsed"
        )
        let stored = SessionPersistence(directoryURL: directory).load(id: call)
        XCTAssertEqual(
            stored?.messages.last?.text, VoiceTurnSpyService.reply,
            "The call session's thread has the reply, saved, ready for the return"
        )
    }

    func testABoardUpdateFromAnAwayTurnLandsOnTheCallSessionsBoard() async {
        let element = BoardElement.text(
            TextElement(id: "hint", x: 10, y: 20, text: "try halves", fontSize: 24)
        )
        let service = VoiceTurnSpyService(
            boardUpdate: BoardSceneUpdate(upserts: [element])
        )
        let store = makeStore(service)
        await store.sendAndWait("fractions please")
        let call = store.session.id
        store.voiceCallBegan()
        store.startNewSession()

        _ = await store.runVoiceTurn(request: "draw me a hint")

        XCTAssertTrue(
            store.session.boardScene.elements.isEmpty,
            "The board on screen belongs to the session on screen"
        )
        let stored = SessionPersistence(directoryURL: directory).load(id: call)
        XCTAssertEqual(stored?.boardScene.elements.count, 1)
    }

    func testTheAwayTurnIsCarriedBackWhenTheLearnerReturns() async {
        let service = VoiceTurnSpyService()
        let store = makeStore(service)
        await store.sendAndWait("fractions please")
        let call = store.session.id
        store.voiceCallBegan()
        store.startNewSession()
        _ = await store.runVoiceTurn(request: "explain")

        store.openSession(id: call)

        XCTAssertEqual(store.session.id, call)
        XCTAssertEqual(
            store.session.messages.last?.text, VoiceTurnSpyService.reply,
            "Coming back shows the turn that ran while the learner was away"
        )
    }

    /// A delegated voice turn writes into the call's session even while the
    /// learner browses another thread. Source evidence is part of that turn,
    /// so it must follow the same routing and survive on disk for the return.
    func testSearchSourcesFromAnAwayTurnLandInTheCallSession() async {
        let source = TutorSource(
            id: "a", title: "Fractions", url: "https://example.com/fractions", snippet: nil
        )
        let service = VoiceTurnSpyService(source: source)
        let store = makeStore(service)
        await store.sendAndWait("fractions please")
        let call = store.session.id
        store.voiceCallBegan()
        store.startNewSession()

        let result = await store.runVoiceTurn(request: "explain fractions")

        guard case .success = result else {
            return XCTFail("The away turn should have completed: \(result)")
        }
        let stored = SessionPersistence(directoryURL: directory).load(id: call)
        XCTAssertEqual(stored?.messages.last?.sources, [source])
    }

    /// `view_board` used to refuse outright whenever the learner had walked
    /// into another session, and that refusal reached the model as "I could
    /// not see the board" — with no board missing at all. The turn's own board
    /// is readable from wherever the learner is standing, and it is *that*
    /// board, never the one on screen.
    func testTheBoardOfTheTurnsSessionIsReadableWhileTheLearnerBrowsesElsewhere() async {
        let element = BoardElement.text(
            TextElement(id: "hint", x: 10, y: 20, text: "try halves", fontSize: 24)
        )
        let service = VoiceTurnSpyService(
            boardUpdate: BoardSceneUpdate(upserts: [element])
        )
        let store = makeStore(service)
        await store.sendAndWait("fractions please")
        let call = store.session.id
        store.voiceCallBegan()
        _ = await store.runVoiceTurn(request: "draw me a hint")

        store.startNewSession()

        XCTAssertEqual(
            store.storedBoard(for: call)?.scene.elements.count, 1,
            "The call session's board is what its own turn must be shown"
        )
        XCTAssertEqual(
            store.storedBoard(for: store.session.id)?.scene.elements.count, 0,
            "And the board on screen stays the property of the session on screen"
        )
    }

    func testTheBoardOfASessionThatDoesNotExistIsNotInvented() {
        let store = makeStore(VoiceTurnSpyService())

        XCTAssertNil(
            store.storedBoard(for: UUID()),
            "A session deleted out from under a call has no board to render"
        )
    }

    // MARK: - The pill

    func testThePillIsVisibleOnlyForACallInAnotherSession() {
        let call = UUID()
        let browsing = UUID()

        XCTAssertTrue(
            CallPill.isVisible(isLive: true, callSessionID: call, visibleSessionID: browsing)
        )
        XCTAssertFalse(
            CallPill.isVisible(isLive: true, callSessionID: call, visibleSessionID: call),
            "In the call's own session the voice bar is on screen; the pill would be noise"
        )
        XCTAssertFalse(
            CallPill.isVisible(isLive: false, callSessionID: call, visibleSessionID: browsing),
            "No call, no pill"
        )
        XCTAssertFalse(
            CallPill.isVisible(isLive: true, callSessionID: nil, visibleSessionID: browsing)
        )
    }

    func testThePillNamesTheCallSession() {
        let pill = CallPill(
            display: VoiceDisplayProvider(),
            sessionTitle: "Long division",
            onReturn: {}
        )

        XCTAssertEqual(pill.label, "Voice · Long division")
        XCTAssertEqual(pill.accessibilityLabel, "Return to voice call in Long division")
    }

    func testThePillSaysSomethingForAnUnnamedSession() {
        let pill = CallPill(display: VoiceDisplayProvider(), sessionTitle: "   ", onReturn: {})

        XCTAssertEqual(pill.label, "Voice · this chat")
    }

    // MARK: - The chrome, and the pill as its complement

    /// The defect this pins: the screen drew the mascot stage, the dock's live
    /// face and the composer's voice mode on `isLive` alone, so a learner who
    /// switched sessions mid-call read another session's thread under the call's
    /// whole surface — a composer with no send disc, whose typed words went to
    /// the call instead of to the tutor of the session on screen.
    func testTheCallChromeIsDrawnOnlyInTheCallsOwnSession() {
        let call = UUID()
        let browsing = UUID()

        XCTAssertTrue(
            VoiceSessionHost.callChromeBelongs(
                isLive: true, callSessionID: call, visibleSessionID: call
            )
        )
        XCTAssertFalse(
            VoiceSessionHost.callChromeBelongs(
                isLive: true, callSessionID: call, visibleSessionID: browsing
            ),
            "The browsed session gets its own thread and its own composer; the pill marks the call"
        )
        XCTAssertFalse(
            VoiceSessionHost.callChromeBelongs(
                isLive: false, callSessionID: nil, visibleSessionID: browsing
            ),
            "No call, no chrome"
        )
        XCTAssertTrue(
            VoiceSessionHost.callChromeBelongs(
                isLive: true, callSessionID: nil, visibleSessionID: browsing
            ),
            "A live call with no session shows its chrome: with no pill either there would be no way to end it"
        )
    }

    /// A live call is drawn in exactly one place — here or on the pill, never
    /// both (the screenshot's defect) and never neither (a call with no way back
    /// and no way out).
    func testALiveCallIsDrawnInExactlyOnePlace() {
        let call = UUID()
        let browsing = UUID()

        for visible in [call, browsing] {
            let chrome = VoiceSessionHost.callChromeBelongs(
                isLive: true, callSessionID: call, visibleSessionID: visible
            )
            let pill = CallPill.isVisible(
                isLive: true, callSessionID: call, visibleSessionID: visible
            )
            XCTAssertNotEqual(chrome, pill, "The chrome and the pill are complements")
        }
    }

    // MARK: - The voice transcript while another session is on screen

    /// The transcript hooks route by the call's session, not by what is on
    /// screen: spoken lines from a call the learner has walked away from must
    /// never appear in the thread they are reading.
    func testAVoiceTranscriptWhileBrowsingElsewhereNeverTouchesTheVisibleThread() async {
        let store = makeStore(VoiceTurnSpyService())
        await store.sendAndWait("fractions please")
        let call = store.session.id
        store.voiceCallBegan()
        store.startNewSession()
        let visible = store.session.id

        store.streamVoiceUserTranscript(itemID: "u1", delta: "Okay, give me time")
        store.finalizeVoiceUserUtterance(itemID: "u1", text: "Okay, give me time to read and think.")
        store.streamVoiceAssistantText(itemID: "a1", delta: "Take your time — tap me when you're ready.")
        store.finishVoiceAssistantResponse(itemID: "a1", delegated: false)

        XCTAssertEqual(store.session.id, visible)
        XCTAssertTrue(
            store.session.messages.isEmpty,
            "Not one spoken word may land in the thread being browsed"
        )
        let stored = SessionPersistence(directoryURL: directory).load(id: call)
        XCTAssertEqual(
            stored?.messages.suffix(2).map(\.text),
            ["Okay, give me time to read and think.", "Take your time — tap me when you're ready."],
            "The call session's own thread holds them, saved"
        )
    }

    /// And they are on screen again the moment the learner comes back.
    func testTheSpokenLinesAreThereOnTheReturnToTheCallSession() async {
        let store = makeStore(VoiceTurnSpyService())
        await store.sendAndWait("fractions please")
        let call = store.session.id
        store.voiceCallBegan()
        store.startNewSession()
        store.streamVoiceAssistantText(itemID: "a1", delta: "Take your time.")
        store.finishVoiceAssistantResponse(itemID: "a1", delegated: false)

        store.openSession(id: call)

        XCTAssertEqual(store.session.id, call)
        XCTAssertEqual(store.session.messages.last?.text, "Take your time.")
    }

    // MARK: - The away board's context

    func testAnAwayTurnCarriesTheStoredSceneAndSaysTheBoardIsNotOnScreen() throws {
        let scene = BoardScene(elements: [
            .text(TextElement(id: "hint", x: 1, y: 2, text: "halves", fontSize: 24)),
        ])

        let context = try XCTUnwrap(TutorStore.storedSceneContext(scene))

        XCTAssertTrue(context.contains("\"board_not_on_screen\":true"))
        XCTAssertTrue(context.contains("hint"))
        XCTAssertFalse(
            context.contains("visible_logical_rect"),
            "There is no viewport to report: the learner is looking at another board"
        )
    }

    func testAnEmptySceneCarriesNoBoardContextAtAll() {
        XCTAssertNil(TutorStore.storedSceneContext(BoardScene(elements: [])))
    }

    // MARK: - The recap primer

    func testAnEmptyThreadSendsNoPrimerAtAll() {
        XCTAssertNil(VoiceRecapPrimer.text(for: []))
        XCTAssertNil(
            VoiceRecapPrimer.text(for: [message(.learner, "   \n  ")]),
            "A bubble with no words is not a conversation to recap"
        )
    }

    func testThePrimerLabelsBothSpeakersAndKeepsTheirOrder() throws {
        let text = try XCTUnwrap(VoiceRecapPrimer.text(for: [
            message(.learner, "How do I add 1/2 and 1/3?"),
            message(.tutor, "Find a common denominator first."),
            message(.learner, "Six?")
        ]))

        XCTAssertTrue(text.hasPrefix(VoiceRecapPrimer.header), "The header explains what follows")
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.suffix(3), [
            "Learner: How do I add 1/2 and 1/3?",
            "Tutor: Find a common denominator first.",
            "Learner: Six?"
        ])
    }

    func testSystemMessagesAndEmptyOnesAreNotConversation() throws {
        let transcript = try XCTUnwrap(VoiceRecapPrimer.transcript(for: [
            message(.system, "session opened"),
            message(.learner, "Ready."),
            message(.tutor, "")
        ]))

        XCTAssertEqual(transcript, "Learner: Ready.")
    }

    func testAMessageWithNewlinesStaysOneLine() throws {
        let transcript = try XCTUnwrap(
            VoiceRecapPrimer.transcript(for: [message(.tutor, "Step 1\nStep 2")])
        )

        XCTAssertEqual(transcript, "Tutor: Step 1 Step 2", "Two lines would read as two speakers")
    }

    func testTruncationDropsTheOldestMessagesAndKeepsWholeOnes() throws {
        let messages = (1...20).map { message(.learner, "Message number \($0) about fractions") }
        let transcript = try XCTUnwrap(VoiceRecapPrimer.transcript(for: messages, budget: 120))

        XCTAssertLessThanOrEqual(transcript.count, 120)
        XCTAssertTrue(
            transcript.hasSuffix("Learner: Message number 20 about fractions"),
            "The newest message is the one the call is about"
        )
        for line in transcript.split(separator: "\n") {
            XCTAssertTrue(line.hasPrefix("Learner: Message number "), "Cut between messages, not inside one")
            XCTAssertTrue(line.hasSuffix(" about fractions"), "A half message is worse than no message")
        }
        XCTAssertFalse(transcript.contains("number 1 "), "The oldest messages fell off the front")
    }

    func testTheWholeThreadSurvivesWhenItFitsTheBudget() throws {
        let transcript = try XCTUnwrap(VoiceRecapPrimer.transcript(
            for: [message(.learner, "Hi"), message(.tutor, "Hello")], budget: 1_000
        ))

        XCTAssertEqual(transcript, "Learner: Hi\nTutor: Hello")
    }

    func testASingleHugeMessageKeepsItsTailAndItsLabel() throws {
        let long = String(repeating: "a", count: 200) + "the last thing said"
        let transcript = try XCTUnwrap(
            VoiceRecapPrimer.transcript(for: [message(.tutor, long)], budget: 60)
        )

        XCTAssertEqual(transcript.count, 60)
        XCTAssertTrue(transcript.hasPrefix("Tutor: "), "A tail with no speaker is a tail the model may claim")
        XCTAssertTrue(transcript.hasSuffix("the last thing said"))
    }

    func testALongOlderMessageIsClampedToItsHeadSoOthersStillFit() throws {
        let essay = "The topic is triangles. " + String(repeating: "x", count: 400)
        let transcript = try XCTUnwrap(VoiceRecapPrimer.transcript(for: [
            message(.tutor, essay),
            message(.learner, "Okay let me try"),
        ]))

        XCTAssertTrue(transcript.contains("Tutor: The topic is triangles. "), "The head names the topic")
        XCTAssertTrue(transcript.contains("…\nLearner: Okay let me try"), "The cut is marked and the rest fits")
        XCTAssertFalse(transcript.contains(String(repeating: "x", count: 301)), "Clamped, not whole")
    }

    func testTheNewestLongMessageKeepsItsTailInstead() throws {
        let essay = String(repeating: "y", count: 400) + " so try the next exercise"
        let transcript = try XCTUnwrap(VoiceRecapPrimer.transcript(for: [message(.tutor, essay)]))

        XCTAssertTrue(transcript.hasPrefix("Tutor: …"), "The cut is marked at the front")
        XCTAssertTrue(transcript.hasSuffix(" so try the next exercise"), "The tail is where the call resumes")
    }

    func testAHugeNewestMessageStillWinsOverOlderOnesThatWouldFit() throws {
        let long = String(repeating: "b", count: 300)
        let transcript = try XCTUnwrap(VoiceRecapPrimer.transcript(
            for: [message(.learner, "short"), message(.tutor, long)], budget: 40
        ))

        XCTAssertTrue(transcript.hasPrefix("Tutor: "))
        XCTAssertFalse(transcript.contains("short"))
    }

    func testThePrimerEncodesAsASystemMessageItem() throws {
        let data = try RealtimeEventEncoder.contextPrimer(text: "WHERE WE ARE — …")
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "conversation.item.create")
        let item = try XCTUnwrap(object["item"] as? [String: Any])
        XCTAssertEqual(item["type"] as? String, "message")
        XCTAssertEqual(item["role"] as? String, "system")
        let content = try XCTUnwrap(item["content"] as? [[String: Any]])
        XCTAssertEqual(content.count, 1)
        XCTAssertEqual(content.first?["type"] as? String, "input_text")
        XCTAssertEqual(content.first?["text"] as? String, "WHERE WE ARE — …")
    }

    // MARK: - Helpers

    private func message(_ role: MessageRole, _ text: String) -> TutorMessage {
        TutorMessage(role: role, text: text)
    }

    private func makeStore(_ service: any TutorService) -> TutorStore {
        TutorStore(
            service: service,
            persistence: SessionPersistence(directoryURL: directory),
            configuration: .stub
        )
    }

    private func settle() async {
        try? await Task.sleep(for: .milliseconds(250))
    }
}

/// Answers every turn with one line, and records which session each turn named.
private final class VoiceTurnSpyService: TutorService, Sendable {
    static let reply = "Find a common denominator first."

    private let sessionIDs = OSAllocatedUnfairLock<[UUID]>(initialState: [])
    private let boardUpdate: BoardSceneUpdate?
    private let source: TutorSource?

    init(boardUpdate: BoardSceneUpdate? = nil, source: TutorSource? = nil) {
        self.boardUpdate = boardUpdate
        self.source = source
    }

    /// The sessions turns went out against, in order — a delegated voice turn
    /// must name the call's session however the learner has wandered.
    var requestedSessionIDs: [UUID] { sessionIDs.withLock { $0 } }

    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        sessionIDs.withLock { $0.append(request.sessionID) }
        let update = boardUpdate
        let source = source
        return AsyncThrowingStream { continuation in
            continuation.yield(.textDelta(Self.reply))
            if let update { continuation.yield(.boardUpdate(update)) }
            if let source {
                continuation.yield(.searchSources(
                    searchID: "s_1", query: "fractions", sources: [source]
                ))
            }
            continuation.yield(.done)
            continuation.finish()
        }
    }
}
