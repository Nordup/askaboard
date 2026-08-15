import Foundation
import XCTest
@testable import MathTutor

/// The voice engine's decisions, driven without a network, a microphone, or a clock of their
/// own. Everything here is the pure-logic layer of `Services/Realtime` — the coordinator wires
/// these types to WebRTC on the device, and the device is where the wiring is verified; the
/// *decisions* are verified here, on injected time.
final class VoiceEngineTests: XCTestCase {

    // MARK: - Barge-in: duck always, cancel only what has made noise

    func testUserSpeechOverASilentResponseDucksButDoesNotCancel() {
        var bargeIn = VoiceBargeIn()
        bargeIn.responseCreated()

        XCTAssertEqual(
            bargeIn.userSpeechStarted(), .duck,
            "A response that has not made a sound is an answer still owed — cancelling it destroys it unheard."
        )
    }

    func testUserSpeechOverAnAudibleResponseDucksAndCancels() {
        var bargeIn = VoiceBargeIn()
        bargeIn.responseCreated()
        bargeIn.responseProducedAudio()

        XCTAssertEqual(bargeIn.userSpeechStarted(), .duckAndCancel)
    }

    func testUserSpeechWithNoResponseInFlightOnlyDucks() {
        var bargeIn = VoiceBargeIn()
        XCTAssertEqual(bargeIn.userSpeechStarted(), .duck)
    }

    func testAFinishedResponseCannotBeCancelled() {
        var bargeIn = VoiceBargeIn()
        bargeIn.responseCreated()
        bargeIn.responseProducedAudio()
        bargeIn.responseEnded()

        XCTAssertEqual(
            bargeIn.userSpeechStarted(), .duck,
            "response.cancel after response.done is a no-op upstream; the duck is the half that still works."
        )
    }

    func testANewResponseStartsSilentAgain() {
        var bargeIn = VoiceBargeIn()
        bargeIn.responseCreated()
        bargeIn.responseProducedAudio()
        bargeIn.responseEnded()
        bargeIn.responseCreated()

        XCTAssertEqual(bargeIn.userSpeechStarted(), .duck)
    }

    // MARK: - Tool-call gate: dedup and single-flight

    func testACallIdArrivingTwiceRunsOnce() {
        var gate = VoiceToolCallGate()
        XCTAssertEqual(gate.decide(callID: "call_1"), .run)
        XCTAssertEqual(
            gate.decide(callID: "call_1"), .duplicate,
            "The same call arrives via function_call_arguments.done and swept out of response.done."
        )
    }

    func testASecondCallWhileOneRunsIsAnsweredBusy() {
        var gate = VoiceToolCallGate()
        XCTAssertEqual(gate.decide(callID: "call_1"), .run)
        XCTAssertEqual(gate.decide(callID: "call_2"), .busy)
    }

    func testTheGateReopensWhenTheRunningCallFinishes() {
        var gate = VoiceToolCallGate()
        _ = gate.decide(callID: "call_1")
        _ = gate.decide(callID: "call_2")
        gate.finished(callID: "call_1")

        XCTAssertEqual(gate.decide(callID: "call_3"), .run)
    }

    func testABusyCallStaysHandledAfterTheGateReopens() {
        var gate = VoiceToolCallGate()
        _ = gate.decide(callID: "call_1")
        XCTAssertEqual(gate.decide(callID: "call_2"), .busy)
        gate.finished(callID: "call_1")

        XCTAssertEqual(
            gate.decide(callID: "call_2"), .duplicate,
            "A call answered {\"error\":\"busy\"} was answered; its sweep copy must not run it after all."
        )
    }

    func testDidRunSeparatesExecutedCallsFromBusyAnswers() {
        var gate = VoiceToolCallGate()
        _ = gate.decide(callID: "call_1")
        _ = gate.decide(callID: "call_2")

        XCTAssertTrue(
            gate.didRun("call_1"),
            "The swept duplicate of a running call still needs its delegation mark — the response id may only arrive with the sweep."
        )
        XCTAssertFalse(
            gate.didRun("call_2"),
            "A busy answer ran nothing; its response's speech must stay in the thread."
        )
    }

    func testFinishingANonRunningCallDoesNotUnlockTheGate() {
        var gate = VoiceToolCallGate()
        _ = gate.decide(callID: "call_1")
        gate.finished(callID: "call_2")

        XCTAssertEqual(gate.decide(callID: "call_3"), .busy)
    }

    // MARK: - Transcript ledger: accumulation keyed by item id

    func testDeltasAccumulatePerItemAcrossInterleavedItems() {
        var ledger = AssistantResponseLedger()
        ledger.responseCreated(responseID: "resp_1")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_a", delta: "One ")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_b", delta: "Two ")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_a", delta: "half.")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_b", delta: "thirds.")

        XCTAssertEqual(ledger.accumulatedText(itemID: "item_a"), "One half.")
        XCTAssertEqual(ledger.accumulatedText(itemID: "item_b"), "Two thirds.")
    }

    func testTheDoneTranscriptReplacesTheAccumulatedDeltasWholesale() {
        var ledger = AssistantResponseLedger()
        ledger.responseCreated(responseID: "resp_1")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_a", delta: "One hal")
        ledger.noteDone(responseID: "resp_1", itemID: "item_a", transcript: "One half.")

        XCTAssertEqual(
            ledger.accumulatedText(itemID: "item_a"), "One half.",
            "The API's done text is authoritative over whatever the deltas summed to."
        )
    }

    func testOnlyTheFirstDeltaOfAResponseCountsAsItsFirstNoise() {
        var ledger = AssistantResponseLedger()
        ledger.responseCreated(responseID: "resp_1")

        XCTAssertTrue(ledger.noteDelta(responseID: "resp_1", itemID: "item_a", delta: "He"))
        XCTAssertFalse(ledger.noteDelta(responseID: "resp_1", itemID: "item_a", delta: "llo"))
        XCTAssertFalse(
            ledger.noteDelta(responseID: "resp_1", itemID: "item_b", delta: "More"),
            "First noise is per response, not per item — the barge-in question is about the response."
        )
    }

    func testFinishReturnsItemsInOrderAndEmptiesThem() {
        var ledger = AssistantResponseLedger()
        ledger.responseCreated(responseID: "resp_1")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_a", delta: "A")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_b", delta: "B")

        let finished = ledger.finish(responseID: "resp_1")
        XCTAssertEqual(finished.map(\.itemID), ["item_a", "item_b"])
        XCTAssertNil(ledger.accumulatedText(itemID: "item_a"))
        XCTAssertTrue(
            ledger.finish(responseID: "resp_1").isEmpty,
            "A response finishes once; a duplicate response.done must not replay the hooks."
        )
    }

    // MARK: - Delegated-response marking (the dedup rule's two halves)

    func testAResponseThatCalledSendToTutorFinishesDelegated() {
        var ledger = AssistantResponseLedger()
        ledger.responseCreated(responseID: "resp_1")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_a", delta: "Let me check the board.")
        ledger.noteDelegated(responseID: "resp_1")

        XCTAssertEqual(
            ledger.finish(responseID: "resp_1"),
            [AssistantResponseLedger.FinishedItem(itemID: "item_a", delegated: true)],
            "The action line is voice glue; the worker's message is the canonical thread content."
        )
    }

    func testAPlainResponseFinishesNotDelegated() {
        var ledger = AssistantResponseLedger()
        ledger.responseCreated(responseID: "resp_1")
        ledger.noteDelta(responseID: "resp_1", itemID: "item_a", delta: "Hi there!")

        XCTAssertEqual(
            ledger.finish(responseID: "resp_1"),
            [AssistantResponseLedger.FinishedItem(itemID: "item_a", delegated: false)],
            "Voice-only small talk stays in the thread."
        )
    }

    func testTheResponseRelayingATutorReplyIsMarkedDelegatedAheadOfItsCreation() {
        var ledger = AssistantResponseLedger()
        ledger.markNextCreatedResponseDelegated()
        ledger.responseCreated(responseID: "resp_2")
        ledger.noteDelta(responseID: "resp_2", itemID: "item_r", delta: "So, one half!")

        XCTAssertEqual(
            ledger.finish(responseID: "resp_2"),
            [AssistantResponseLedger.FinishedItem(itemID: "item_r", delegated: true)],
            "The rephrase of tutor_reply duplicates the worker's streamed message and must be dropped."
        )
    }

    func testTheRelayMarkSpendsItselfOnExactlyOneResponse() {
        var ledger = AssistantResponseLedger()
        ledger.markNextCreatedResponseDelegated()
        ledger.responseCreated(responseID: "resp_2")
        ledger.responseCreated(responseID: "resp_3")
        ledger.noteDelta(responseID: "resp_3", itemID: "item_s", delta: "Anything else?")

        XCTAssertEqual(
            ledger.finish(responseID: "resp_3"),
            [AssistantResponseLedger.FinishedItem(itemID: "item_s", delegated: false)]
        )
    }

    // MARK: - Mute guard: every mute has an owner

    func testAnInterruptionMuteRecoversByWatchdogWhenTheEndNeverArrives() {
        var guardUnderTest = MicMuteGuard()
        guardUnderTest.interruptionBegan(reason: "interruption", at: 100)

        XCTAssertEqual(guardUnderTest.tick(at: 101), .none)
        let action = guardUnderTest.tick(at: 100 + MicMuteGuard.interruptionWatchdogSeconds)
        guard case .reenableMicrophone = action else {
            return XCTFail("AVFoundation does not guarantee .ended; the watchdog is the owner it lacks. Got \(action).")
        }
        XCTAssertTrue(guardUnderTest.shouldTransmit)
        XCTAssertEqual(
            guardUnderTest.tick(at: 200), .none,
            "A recovered mute is gone; the watchdog must not fire again on nothing."
        )
    }

    func testAnInterruptionEndReleasesTheMuteBeforeTheWatchdog() {
        var guardUnderTest = MicMuteGuard()
        guardUnderTest.interruptionBegan(reason: "interruption", at: 100)

        guard case .reenableMicrophone = guardUnderTest.interruptionEnded(at: 101) else {
            return XCTFail("The interruption ending is the ordinary recovery path.")
        }
        XCTAssertTrue(guardUnderTest.shouldTransmit)
    }

    func testARouteChangeWhileMutedIsAnEarlyChanceToRecover() {
        var guardUnderTest = MicMuteGuard()
        guardUnderTest.interruptionBegan(reason: "interruption", at: 100)

        guard case .reenableMicrophone = guardUnderTest.routeChanged(at: 101) else {
            return XCTFail("Route changes keep arriving while a session is interrupted; each one may notice the orphaned mute.")
        }
    }

    func testARouteChangeWithNothingMutedDoesNothing() {
        var guardUnderTest = MicMuteGuard()
        XCTAssertEqual(guardUnderTest.routeChanged(at: 100), .none)
    }

    func testTheUsersMuteNeverExpires() {
        var guardUnderTest = MicMuteGuard()
        guardUnderTest.setUserMuted(true)

        XCTAssertEqual(guardUnderTest.tick(at: 10_000), .none)
        XCTAssertFalse(guardUnderTest.shouldTransmit, "The user's mute is owned by the user, not by a watchdog.")
    }

    func testWatchdogRecoveryUnderneathAUserMuteStillDoesNotTransmit() {
        var guardUnderTest = MicMuteGuard()
        guardUnderTest.setUserMuted(true)
        guardUnderTest.interruptionBegan(reason: "interruption", at: 100)

        guard case .reenableMicrophone = guardUnderTest.tick(at: 200) else {
            return XCTFail("The session still wants re-asserting even under a user mute.")
        }
        XCTAssertFalse(
            guardUnderTest.shouldTransmit,
            "Recovery applies shouldTransmit, and a user mute survives every recovery."
        )
    }

    // MARK: - Level normalization (−48…−12 dBFS)

    func testTheSpeechBandMapsToTheFullScale() {
        // −48 dBFS is amplitude 10^(−48/20); −12 is 10^(−12/20); −30 is halfway in decibels.
        XCTAssertEqual(VoiceLevel.normalizedSpeechLevel(linearAmplitude: pow(10, -48.0 / 20)), 0, accuracy: 1e-9)
        XCTAssertEqual(VoiceLevel.normalizedSpeechLevel(linearAmplitude: pow(10, -30.0 / 20)), 0.5, accuracy: 1e-9)
        XCTAssertEqual(VoiceLevel.normalizedSpeechLevel(linearAmplitude: pow(10, -12.0 / 20)), 1, accuracy: 1e-9)
    }

    func testLevelsOutsideTheBandClampInsteadOfLeaking() {
        XCTAssertEqual(VoiceLevel.normalizedSpeechLevel(linearAmplitude: 1), 1, "0 dBFS clamps to full scale.")
        XCTAssertEqual(VoiceLevel.normalizedSpeechLevel(linearAmplitude: 1e-6), 0, "A silent room clamps to the floor.")
        XCTAssertEqual(VoiceLevel.normalizedSpeechLevel(linearAmplitude: 0), 0)
        XCTAssertEqual(VoiceLevel.normalizedSpeechLevel(linearAmplitude: .nan), 0)
    }

    // MARK: - Capture reducer: absent statistics are nil, never 0

    func testAbsentAccumulatorsProduceNoVerdict() {
        var reducer = CaptureLevelReducer()
        XCTAssertNil(
            reducer.intervalAmplitude(energy: nil, duration: nil),
            "A build that publishes no accumulators has measured nothing — nil, never a silent-room 0."
        )
    }

    func testTheFirstReadingHasNoIntervalToJudge() {
        var reducer = CaptureLevelReducer()
        XCTAssertNil(reducer.intervalAmplitude(energy: 0.5, duration: 10))
    }

    func testASteadyCaptureYieldsTheIntervalRMS() {
        var reducer = CaptureLevelReducer()
        _ = reducer.intervalAmplitude(energy: 1.0, duration: 10)
        // One more second of capture at amplitude 0.2: energy grows by 0.2² × 1 s = 0.04.
        let amplitude = reducer.intervalAmplitude(energy: 1.04, duration: 11)
        XCTAssertEqual(amplitude ?? -1, 0.2, accuracy: 1e-9)
    }

    func testACounterGoingBackwardsMeansARebuiltChainNotSilence() {
        var reducer = CaptureLevelReducer()
        _ = reducer.intervalAmplitude(energy: 1.0, duration: 10)
        XCTAssertNil(
            reducer.intervalAmplitude(energy: 0.1, duration: 2),
            "A media-services reset restarts the accumulators; there is nothing to conclude."
        )
        // The next interval measures from the rebuilt chain's own baseline.
        let amplitude = reducer.intervalAmplitude(energy: 0.1 + 0.04, duration: 3)
        XCTAssertEqual(amplitude ?? -1, 0.2, accuracy: 1e-9)
    }

    func testAGapInTheStatisticsResetsTheBaseline() {
        var reducer = CaptureLevelReducer()
        _ = reducer.intervalAmplitude(energy: 1.0, duration: 10)
        _ = reducer.intervalAmplitude(energy: nil, duration: nil)
        XCTAssertNil(
            reducer.intervalAmplitude(energy: 2.0, duration: 20),
            "A verdict spanning a dark interval would report the gap as the room."
        )
    }

    // MARK: - Assistant speech proxy

    func testTranscriptDeltasRaiseTheLevelAndSilenceDrainsIt() {
        var proxy = AssistantSpeechProxy()
        proxy.noteTranscriptDelta(characters: 12, at: 0)

        let justAfter = proxy.level(at: 0)
        XCTAssertGreaterThan(justAfter, 0)
        XCTAssertLessThan(
            proxy.level(at: 0.5), justAfter,
            "The proxy drains between deltas — the bob follows the cadence."
        )
        XCTAssertLessThan(proxy.level(at: 3), 0.01, "A pause reads as near-dark.")
    }

    func testTheLoudspeakerStoppingForcesDarkImmediately() {
        var proxy = AssistantSpeechProxy()
        proxy.noteTranscriptDelta(characters: 40, at: 0)
        proxy.noteOutputAudioStopped()

        XCTAssertEqual(
            proxy.level(at: 0), 0,
            "A voice that has stopped must not keep bobbing the mascot on stale deltas."
        )
    }

    func testAnActiveOutputBufferHoldsAnAudibleFloor() {
        var proxy = AssistantSpeechProxy()
        proxy.noteTranscriptDelta(characters: 12, at: 0)
        proxy.noteOutputAudioStarted()

        XCTAssertGreaterThanOrEqual(
            proxy.level(at: 10), AssistantSpeechProxy.audibleFloor,
            "While output_audio_buffer says the voice is playing, the mascot never reads fully dark."
        )
    }

    // MARK: - Tool arguments

    @MainActor
    func testTheRequestArgumentIsExtractedFromTheCallJSON() {
        XCTAssertEqual(
            VoiceSessionCoordinator.request(fromArguments: #"{"request": "Explain one half"}"#),
            "Explain one half"
        )
        XCTAssertNil(VoiceSessionCoordinator.request(fromArguments: "not json"))
        XCTAssertNil(VoiceSessionCoordinator.request(fromArguments: "{}"))
        XCTAssertNil(
            VoiceSessionCoordinator.request(fromArguments: #"{"request": "   "}"#),
            "A blank request is a malformed call, not a turn to run."
        )
    }

    // MARK: - Wire shapes

    func testFunctionCallOutputCarriesTheResultAsAJSONStringNotDoubleEncoded() throws {
        let data = try RealtimeEventEncoder.functionCallOutput(
            callId: "call_1",
            output: ["tutor_reply": "One half."]
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "conversation.item.create")
        let item = try XCTUnwrap(object["item"] as? [String: Any])
        XCTAssertEqual(item["type"] as? String, "function_call_output")
        XCTAssertEqual(item["call_id"] as? String, "call_1")
        XCTAssertEqual(
            item["output"] as? String, #"{"tutor_reply":"One half."}"#,
            "The output field is a JSON string; anything else the model receives as an escaped blob."
        )
    }

    func testTheKeepaliveMergesNothingAndCarriesNoNumber() throws {
        let data = try RealtimeEventEncoder.keepalive()
        XCTAssertEqual(
            String(decoding: data, as: UTF8.self).contains("\"instructions\""), false
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "session.update")
        XCTAssertEqual(
            object["session"] as? [String: String], ["type": "realtime"],
            "A keepalive that can be rejected spams the error channel; this one carries nothing rejectable."
        )
    }

    func testTypedTextBecomesAUserMessageItem() throws {
        let data = try RealtimeEventEncoder.userTextItem(text: "what about 3/4?")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let item = try XCTUnwrap(object["item"] as? [String: Any])
        XCTAssertEqual(item["role"] as? String, "user")
        let content = try XCTUnwrap(item["content"] as? [[String: String]])
        XCTAssertEqual(content, [["type": "input_text", "text": "what about 3/4?"]])
    }

    func testFunctionCallArgumentsDoneDecodesWithItsResponseId() throws {
        let payload = """
        {"type": "response.function_call_arguments.done", "response_id": "resp_9",
         "call_id": "call_7", "name": "send_to_tutor", "arguments": "{\\"request\\": \\"hi\\"}"}
        """
        let event = RealtimeEventDecoder.decode(Data(payload.utf8))
        XCTAssertEqual(
            event,
            .functionCallArgumentsDone(
                RealtimeFunctionCall(callId: "call_7",
                                     name: "send_to_tutor",
                                     argumentsJSON: #"{"request": "hi"}"#),
                responseId: "resp_9"
            ),
            "Delegation marking needs to know which response called the tool."
        )
    }

    func testResponseDoneSweepsFunctionCallsOutOfItsOutput() throws {
        let payload = """
        {"type": "response.done", "response": {"id": "resp_9", "status": "completed",
         "output": [{"type": "function_call", "call_id": "call_7", "name": "send_to_tutor",
                     "arguments": "{}"}]}}
        """
        guard case .responseDone(let responseId, _, _, let calls) =
                RealtimeEventDecoder.decode(Data(payload.utf8)) else {
            return XCTFail("response.done did not decode")
        }
        XCTAssertEqual(responseId, "resp_9")
        XCTAssertEqual(calls.map(\.callId), ["call_7"],
                       "function_call_arguments.done is not guaranteed; the sweep is the safety net.")
    }
}
