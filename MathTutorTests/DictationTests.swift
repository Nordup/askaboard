import AVFAudio
import SwiftUI
import XCTest
@testable import MathTutor

/// Dictation, driven through every state a microphone would have to be present to reach.
///
/// The simulator has no usable microphone and a permission alert cannot be answered from a
/// test, so one half of this feature — a refusal, a restriction, a missing key, a transcript
/// that stops mid-sentence — is only reachable through the protocol. That is what the protocol
/// is for; `DemoTutorService` does the same job for the tutor.
///
/// The other half — the request, the streamed response and every way it can fail — has no
/// microphone in it at all, so it is driven for real through a stubbed `URLSession`.
@MainActor
final class DictationTests: XCTestCase {
    // MARK: - Whether the button exists at all

    func testTheComposerOffersTheMicOnlyWhenThePlatformCanDictate() {
        let field = ComposerField()

        let capable = DictationController(service: ScriptedDictationService(isSupported: true))
        XCTAssertNotNil(
            composer(voice: capable.voiceHandler(text: field.binding)).onVoice,
            "Dictation is available, so the design's mic is drawn."
        )

        let incapable = DictationController(service: ScriptedDictationService(isSupported: false))
        XCTAssertNil(
            composer(voice: incapable.voiceHandler(text: field.binding)).onVoice,
            "A composer with nothing behind the mic gets the design's other composer, not a dead button."
        )
    }

    /// A refused permission must not take the button away with it: the refusal is recoverable,
    /// and the mic is the only control that leads to the recovery.
    func testARefusedPermissionStillOffersTheButton() {
        let controller = DictationController(
            service: ScriptedDictationService(isSupported: true, availability: .denied)
        )

        XCTAssertNotNil(composer(voice: controller.voiceHandler(text: ComposerField().binding)).onVoice)
    }

    // MARK: - A session that works

    func testListeningWritesEveryPartialResultIntoTheComposerAndEndsOnTheFinalOne() async {
        let field = ComposerField()
        let service = ScriptedDictationService(script: [
            DictationTranscript(text: "why does", isFinal: false),
            DictationTranscript(text: "why does the arrow", isFinal: false),
            DictationTranscript(text: "Why does the arrow start at zero?", isFinal: true),
        ])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await controller.session?.value

        XCTAssertEqual(field.text, "Why does the arrow start at zero?")
        XCTAssertFalse(controller.isListening, "A completed transcript ends the session on its own.")
        XCTAssertNil(controller.notice)
        XCTAssertEqual(service.startCount, 1)
    }

    func testDictationContinuesTheSentenceTheStudentAlreadyTyped() async {
        let field = ComposerField("I think")
        let controller = DictationController(
            service: ScriptedDictationService(script: [
                DictationTranscript(text: "the answer is twelve", isFinal: true),
            ])
        )

        controller.toggle(text: field.binding)
        await controller.session?.value

        XCTAssertEqual(field.text, "I think the answer is twelve")
    }

    func testMergingNeitherDoublesASpaceNorRunsTwoWordsTogether() {
        XCTAssertEqual(DictationController.merged(base: "", transcript: "hello"), "hello")
        XCTAssertEqual(DictationController.merged(base: "I think", transcript: "so"), "I think so")
        XCTAssertEqual(DictationController.merged(base: "I think ", transcript: "so"), "I think so")
        XCTAssertEqual(DictationController.merged(base: "I think", transcript: ""), "I think")
    }

    func testASecondTapEndsTheSessionAndKeepsWhatWasHeard() async {
        let field = ComposerField()
        // No final result: the student stops talking and taps the mic again.
        let service = ScriptedDictationService(script: [
            DictationTranscript(text: "add both sides", isFinal: false, phase: .capturing),
        ])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { field.text == "add both sides" })
        XCTAssertTrue(controller.isListening)

        controller.toggle(text: field.binding)
        await controller.session?.value

        XCTAssertEqual(field.text, "add both sides", "The words the student watched appear are the words they keep.")
        XCTAssertFalse(controller.isListening)
        XCTAssertEqual(service.startCount, 1, "A second tap ends the session rather than starting another.")
        XCTAssertGreaterThanOrEqual(service.stopCount, 1)
        XCTAssertNil(controller.notice, "Stopping on purpose is not a failure.")
    }

    func testSendingEndsAnOpenSession() async {
        let field = ComposerField()
        let service = ScriptedDictationService(script: [
            DictationTranscript(text: "check my working", isFinal: false),
        ])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { controller.isListening })

        // What `BoardScreen.send` and every presentation change call.
        controller.stop()
        await controller.session?.value

        XCTAssertFalse(controller.isListening)
        XCTAssertGreaterThanOrEqual(service.stopCount, 1)
    }

    // MARK: - Permission

    func testTheFirstTapAsksAndThenListens() async {
        let field = ComposerField()
        let service = ScriptedDictationService(
            availability: .needsPermission,
            authorizationOutcome: .ready,
            script: [DictationTranscript(text: "ok", isFinal: true)]
        )
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await controller.session?.value

        XCTAssertEqual(service.authorizationRequests, 1)
        XCTAssertEqual(service.startCount, 1)
        XCTAssertEqual(field.text, "ok")
        XCTAssertNil(controller.notice)
    }

    func testARefusalAtThePromptRaisesTheNoticeInsteadOfOpeningTheMicrophone() async {
        let field = ComposerField()
        let service = ScriptedDictationService(
            availability: .needsPermission,
            authorizationOutcome: .denied,
            script: [DictationTranscript(text: "never heard", isFinal: true)]
        )
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await controller.session?.value

        XCTAssertEqual(controller.notice, .permission)
        XCTAssertEqual(service.startCount, 0)
        XCTAssertEqual(field.text, "")
        XCTAssertFalse(controller.isListening)
    }

    /// iOS shows its permission alert once per install, so a second tap on an already-refused
    /// mic has to lead somewhere rather than ask again into the void.
    func testAnAlreadyRefusedPermissionGoesStraightToTheNoticeWithoutAskingAgain() async {
        let service = ScriptedDictationService(availability: .denied)
        let controller = DictationController(service: service)

        controller.toggle(text: .constant(""))
        await controller.session?.value

        XCTAssertEqual(controller.notice, .permission)
        XCTAssertEqual(service.authorizationRequests, 0)
        XCTAssertEqual(service.startCount, 0)
    }

    func testTheNoticeNamesTheRouteOutRatherThanTheApiThatFailed() {
        XCTAssertTrue(DictationNotice.permission.message.contains("Settings"))
        XCTAssertTrue(DictationNotice.permission.message.contains("type your question"))
        XCTAssertTrue(DictationNotice.unavailable.message.contains("type your question"))
    }

    func testDismissingTheNoticeClearsIt() async {
        let controller = DictationController(service: ScriptedDictationService(availability: .denied))

        controller.toggle(text: .constant(""))
        await controller.session?.value
        XCTAssertEqual(controller.notice, .permission)

        controller.notice = nil
        XCTAssertNil(controller.notice)
    }

    // MARK: - Unavailable

    func testAnUnavailableRecogniserSaysSoAndNeverOpensTheMicrophone() async {
        let service = ScriptedDictationService(availability: .unavailable)
        let controller = DictationController(service: service)

        controller.toggle(text: .constant(""))
        await controller.session?.value

        XCTAssertEqual(controller.notice, .unavailable)
        XCTAssertEqual(service.startCount, 0)
    }

    func testAMicrophoneThatWillNotOpenIsReportedRatherThanSwallowed() async {
        let service = ScriptedDictationService(startError: .audioUnavailable)
        let controller = DictationController(service: service)

        controller.toggle(text: .constant(""))
        await controller.session?.value

        XCTAssertEqual(controller.notice, .unavailable)
        XCTAssertFalse(controller.isListening)
        XCTAssertEqual(service.startCount, 1, "It was tried; it is the microphone that refused.")
    }

    /// A transcript that stops mid-sentence takes its half-sentence with it.
    ///
    /// This is the one behaviour that changed with the backend and it changed on purpose:
    /// accepting the fragment would hand a student half of what they said, in a field they are
    /// about to send from, with nothing to tell them the rest is missing. What they *typed*
    /// still survives — that was never dictation's to lose.
    func testATranscriptThatStopsMidSentenceKeepsTypedTextAndDropsTheFragment() async {
        let field = ComposerField("I think")
        let service = ScriptedDictationService(script: [
            DictationTranscript(text: "so the next step", isFinal: false),
        ])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { field.text == "I think so the next step" })

        service.failInFlight()
        await controller.session?.value

        XCTAssertEqual(field.text, "I think", "The typed half survives; the fragment does not.")
        XCTAssertEqual(controller.note, .failed)
        XCTAssertNil(controller.notice)
        XCTAssertFalse(controller.isListening)
    }

    // MARK: - Reading the permission and the key

    /// The four-way answer is a pure function of the microphone permission and whether there is
    /// a key, precisely so this can be asserted on a machine with no microphone and no way to
    /// answer an alert.
    func testEveryCombinationOfTheMicrophonePermissionAndTheKey() {
        func resolve(
            _ microphone: AVAudioApplication.recordPermission,
            hasCredential: Bool = true
        ) -> DictationAvailability {
            .resolve(microphone: microphone, hasCredential: hasCredential)
        }

        XCTAssertEqual(resolve(.granted), .ready)
        XCTAssertEqual(resolve(.undetermined), .needsPermission)
        XCTAssertEqual(resolve(.denied), .denied)

        // A missing key outranks every answer the permission could give: there is nothing to
        // transcribe with, so asking a child for their microphone would be taking a permission
        // the app cannot use.
        XCTAssertEqual(resolve(.granted, hasCredential: false), .unavailable)
        XCTAssertEqual(resolve(.undetermined, hasCredential: false), .unavailable)
        XCTAssertEqual(resolve(.denied, hasCredential: false), .unavailable)
    }

    /// The first-run state: no backend configuration, so no dictation and — the part that
    /// matters — no mic in the composer rather than one that can only ever raise a notice.
    /// `DictationServiceRouter` is the conformer that answers this now, mirroring
    /// `TutorServiceRouter`'s own configuration gating for the tutor.
    func testWithoutBackendConfigurationThereIsNoDictationAndNoMicrophoneToTap() {
        let router = DictationServiceRouter(configurationReader: { nil })

        XCTAssertFalse(router.isSupported)
        XCTAssertEqual(router.availability, .unavailable)

        let controller = DictationController(service: router)
        XCTAssertNil(
            composer(voice: controller.voiceHandler(text: ComposerField().binding)).onVoice,
            "A composer with no backend configuration gets the design's other composer, not a dead button."
        )
    }

    /// The other side of the same rule: a configuration is the whole of what makes the mic
    /// appear. What the permission then says is the microphone's business, and never
    /// `.unavailable`.
    func testConfigurationIsWhatPutsTheMicrophoneInTheComposer() {
        let router = DictationServiceRouter(configurationReader: { Self.backendConfiguration })

        XCTAssertTrue(router.isSupported)
        XCTAssertNotEqual(router.availability, .unavailable)
        XCTAssertNotNil(
            composer(voice: DictationController(service: router).voiceHandler(text: ComposerField().binding)).onVoice
        )
    }

    // MARK: - The two phases

    /// The interaction the provider change forced: text no longer appears while the student
    /// talks, so the second tap is the middle of the session and the composer has to say which
    /// half it is in.
    func testTheComposerCanTellCapturingFromTranscribing() async {
        let field = ComposerField()
        let service = ScriptedDictationService(script: [])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { controller.isListening })
        XCTAssertEqual(controller.voiceState, .capturing)
        XCTAssertEqual(controller.composerDictation?.phase, .capturing)

        // What the service yields the moment the microphone closes.
        service.yield(DictationTranscript(text: "", isFinal: false, phase: .transcribing))
        await settle(until: { controller.phase == .transcribing })
        XCTAssertEqual(controller.voiceState, .transcribing)
        XCTAssertEqual(field.text, "", "The marker that the microphone closed carries no words.")

        service.yield(DictationTranscript(text: "Why does sine repeat?", isFinal: true))
        await controller.session?.value

        XCTAssertEqual(field.text, "Why does sine repeat?")
        XCTAssertNil(controller.voiceState, "A finished session shows the mic again, not a phase.")
        XCTAssertNil(controller.composerDictation)
        XCTAssertNil(controller.note, "A transcript that arrived is not a note.")
    }

    /// Apple's model, and the reason the glyph never changes: the label is the control's
    /// identity and holds still, the value carries the state.
    func testTheMicIsNamedOnceAndSaysItsStateInItsValue() {
        XCTAssertEqual(ComposerVoiceButton.label, "Dictate")
        XCTAssertEqual(ComposerVoiceButton.value(for: nil), "")
        XCTAssertEqual(ComposerVoiceButton.value(for: .capturing), "Recording")
        XCTAssertEqual(ComposerVoiceButton.value(for: .transcribing), "Transcribing")
    }

    /// The composer's own cancel, which is what the leading cross calls.
    func testCancellingWhileTheWordsAreArrivingTakesTheDictationBack() async {
        let field = ComposerField("I think")
        let service = ScriptedDictationService(script: [])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { controller.isListening })
        service.yield(DictationTranscript(text: "", isFinal: false, phase: .transcribing))
        await settle(until: { controller.phase == .transcribing })

        controller.cancel()
        await controller.session?.value

        XCTAssertGreaterThanOrEqual(service.cancelCount, 1)
        XCTAssertEqual(field.text, "I think", "Nothing had arrived, so nothing is added.")
        XCTAssertNil(controller.notice, "Taking it back on purpose is not a failure.")
        XCTAssertNil(controller.note, "And it is not something to explain, either.")
        XCTAssertFalse(controller.isListening)
    }

    /// Send empties the composer. A transcription still in flight would drop the last thing the
    /// student said into a field they have already sent from, so it is abandoned rather than
    /// finished.
    func testSendingAbandonsATranscriptionRatherThanLettingItLandLater() async {
        let service = ScriptedDictationService(script: [])
        let controller = DictationController(service: service)

        controller.toggle(text: .constant(""))
        await settle(until: { controller.isListening })
        service.yield(DictationTranscript(text: "", isFinal: false, phase: .transcribing))
        await settle(until: { controller.phase == .transcribing })

        // What `BoardScreen.send` calls.
        controller.stop()
        await controller.session?.value

        XCTAssertGreaterThanOrEqual(service.cancelCount, 1)
        XCTAssertFalse(controller.isListening)
    }

    // MARK: - The request

    /// The multipart contract `server/app/api/dictation.py` documents: `audio` (the WAV,
    /// filename `speech.wav`, `Content-Type: audio/wav`) and `session_id` (the form field the
    /// endpoint 404s without), posted to `{baseURL}/v1/dictation` with the bearer token.
    /// Verified against the endpoint's own field names, not guessed from the brief — see
    /// `server/tests/test_dictation.py`'s `_post_dictation`, which builds the identical request
    /// server-side tests drive: `files={"audio": (...)}, data={"session_id": ...}`.
    func testTheDictationRequestIsTheOneTheEndpointDocuments() throws {
        let audio = Data("RIFFfake".utf8)
        let sessionID = UUID()
        let request = BackendDictationRequestBuilder.urlRequest(
            audio: audio,
            sessionID: sessionID,
            configuration: Self.backendConfiguration,
            boundary: "BOUNDARY"
        )

        XCTAssertEqual(request.url?.absoluteString, "https://backend.example.com/v1/dictation")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Content-Type"),
            "multipart/form-data; boundary=BOUNDARY"
        )

        let body = try XCTUnwrap(request.httpBody)
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        XCTAssertTrue(text.contains("name=\"session_id\"\r\n\r\n\(sessionID.uuidString)\r\n"))
        XCTAssertTrue(text.contains("name=\"audio\"; filename=\"speech.wav\""))
        XCTAssertTrue(text.contains("Content-Type: audio/wav"))
        XCTAssertTrue(text.contains("RIFFfake"))
        XCTAssertTrue(text.hasSuffix("--BOUNDARY--\r\n"))
    }

    /// The audio is bytes, not text, and a multipart builder that goes through `String`
    /// anywhere would quietly mangle it.
    func testTheAudioSurvivesTheMultipartBodyByteForByte() {
        let audio = Data([0x00, 0xFF, 0xFE, 0x80, 0x0A, 0x0D])
        let body = BackendDictationRequestBuilder.multipartBody(audio: audio, sessionID: UUID(), boundary: "B")

        XCTAssertNotNil(body.range(of: audio))
    }

    // MARK: - The streamed response

    func testDeltasAccumulateIntoARunningTranscriptAndTheDoneEventCompletesIt() async throws {
        let transcript = try await transcripts(from: """
            data: {"type":"text_delta","text":"why does "}

            data: {"type":"text_delta","text":"sine "}

            data: {"type":"done","text":"Why does sine repeat?"}

            """)

        XCTAssertEqual(transcript.map(\.text), ["why does ", "why does sine ", "Why does sine repeat?"])
        XCTAssertEqual(transcript.map(\.isFinal), [false, false, true])
        XCTAssertTrue(transcript.allSatisfy { $0.phase == .transcribing })
    }

    /// `server/app/api/dictation.py` sends `done` with an *empty* `text` on purpose when
    /// `is_silence` judges the whole recording boilerplate — `final_text = "" if is_silence(text)
    /// else text` — overriding whatever partial words the deltas already showed. The client has
    /// to treat that empty string as authoritative rather than as "nothing to report", which is
    /// the one behavioural difference from the OpenAI-direct reader this replaced.
    func testADoneEventWithEmptyTextOverridesWhateverTheDeltasShowed() async throws {
        let transcript = try await transcripts(from: """
            data: {"type":"text_delta","text":"Thank"}

            data: {"type":"done","text":""}

            """)

        XCTAssertEqual(transcript.map(\.text), ["Thank", ""])
        XCTAssertEqual(transcript.last?.isFinal, true)
    }

    /// The connection drops mid-sentence, with no `done` and no `error`. The composer must not
    /// sit waiting for a rest of it that is never coming.
    func testATruncatedStreamFailsCleanlyRatherThanHanging() async {
        do {
            _ = try await transcripts(from: """
                data: {"type":"text_delta","text":"why does "}

                data: {"type":"text_del
                """)
            XCTFail("A stream that never says it is done is a failure, not a completed transcript.")
        } catch {
            XCTAssertEqual(error as? DictationError, .recognitionFailed)
        }
    }

    /// The server's own `error` event — a persistence failure, a truncated OpenAI stream, or a
    /// provider failure that survived the server's retries (`server/app/api/dictation.py`'s
    /// `ErrorEvent`). Never the old HTTP-status path: this is a 200 response that fails
    /// mid-stream, which the OpenAI-direct architecture never had a client-visible equivalent
    /// of.
    func testAnErrorEventEndsTheStreamAsAFailureRatherThanASilentStop() async {
        do {
            _ = try await transcripts(from: """
                data: {"type":"text_delta","text":"why does "}

                data: {"type":"error","message":"AttachmentWriteError: could not save the recording.","retryable":false}

                """)
            XCTFail("An error event is not a completed transcript.")
        } catch {
            XCTAssertEqual(error as? DictationError, .recognitionFailed, "Never the server's own message — it can quote what was heard.")
        }
    }

    func testTheReaderSkipsEveryLineThatIsNotADictationFrame() {
        var reader = BackendDictationReader()

        XCTAssertNil(reader.read(""))
        XCTAssertNil(reader.read(": keep-alive"))
        XCTAssertNil(reader.read("event: text_delta"))
        XCTAssertNil(reader.read("data: {this is not json"))
        XCTAssertNil(reader.read(#"data: {"type":"text_delta"}"#), "A delta with no text in it.")
        XCTAssertNil(reader.read(#"data: {"type":"status","phase":"thinking"}"#), "Not a dictation event.")
        XCTAssertEqual(reader.text, "")
        XCTAssertFalse(reader.isComplete)

        guard case .transcript(let reading)? = reader.read(#"data: {"type":"done","text":"ok"}"#) else {
            return XCTFail("Expected a transcript reading.")
        }
        XCTAssertEqual(reading.text, "ok")
        XCTAssertTrue(reader.isComplete)
        XCTAssertNil(reader.read(#"data: {"type":"text_delta","text":" more"}"#), "Nothing follows done.")
    }

    // MARK: - Failure

    /// 401 and everything else end differently, and neither can put the server's own words on
    /// screen: the body is never read, and `DictationError` has no room to carry one.
    func testAnHttpFailureBecomesAFixedSentenceThatQuotesNothingTheStudentSaid() async {
        for status in [401, 404, 429, 500] {
            StubURLProtocol.reset()
            StubURLProtocol.status = status
            StubURLProtocol.body = "Incorrect bearer token."
            do {
                _ = try await collect(BackendDictationClient(configuration: Self.backendConfiguration, session: StubURLProtocol.stubbedSession))
                XCTFail("HTTP \(status) is not a transcript.")
            } catch {
                XCTAssertEqual(error as? DictationError, BackendDictationClient.failure(status: status))
            }
        }

        // A device token the server refuses is the same answer as having no configuration:
        // nothing about this session works until it changes. The rest is worth another tap —
        // including a 404 for an unrecognised `session_id`, which is a wiring bug worth
        // surfacing as "try again", not "no dictation at all".
        XCTAssertEqual(BackendDictationClient.failure(status: 401), .unavailable)
        XCTAssertEqual(BackendDictationClient.failure(status: 403), .unavailable)
        XCTAssertEqual(BackendDictationClient.failure(status: 404), .recognitionFailed)
        XCTAssertEqual(BackendDictationClient.failure(status: 429), .recognitionFailed)
        XCTAssertEqual(BackendDictationClient.failure(status: 500), .recognitionFailed)

        for message in [
            DictationNotice.permission.message,
            DictationNotice.unavailable.message,
            DictationNote.empty.text,
            DictationNote.failed.text
        ] {
            XCTAssertFalse(message.contains("bearer"))
        }
    }

    /// The whole path, end to end: a provider failure reaches the student as one fixed
    /// sentence in the composer and nothing else.
    func testAFailedTranscriptionReachesTheStudentAsTheFixedLine() async {
        let field = ComposerField()
        let service = ScriptedDictationService(script: [])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { controller.isListening })
        service.yield(DictationTranscript(text: "", isFinal: false, phase: .transcribing))
        await settle(until: { controller.phase == .transcribing })

        service.failInFlight(.recognitionFailed)
        await controller.session?.value

        XCTAssertEqual(controller.note, .failed)
        XCTAssertEqual(controller.noteText, "That didn't come back as text. You can try again, or type it.")
        XCTAssertNil(controller.notice, "A failed transcription is not a modal over the board.")
        XCTAssertFalse(controller.isListening)
    }

    // MARK: - What is recorded

    /// The endpoint rejects files over 25 MB. The cap is on the recording rather than on the
    /// upload, so the session ends by transcribing what was said instead of failing a request
    /// the student never saw.
    func testTheRecordingStopsFarShortOfTheEndpointsFileLimit() {
        let endpointLimit = 25 * 1024 * 1024

        XCTAssertEqual(BackendDictationService.captureLimit, 60)
        XCTAssertLessThan(
            BackendDictationService.byteLimit(sampleRate: 16_000) + WAVFile.headerBytes,
            endpointLimit / 10,
            "A minute at 16 kHz mono is under a tenth of the ceiling."
        )
        XCTAssertLessThan(
            BackendDictationService.byteLimit(sampleRate: 48_000) + WAVFile.headerBytes,
            endpointLimit,
            "And still under it if the route refuses 16 kHz and hands back its own rate."
        )
    }

    func testTheWavHeaderSaysWhatTheSamplesActuallyAre() throws {
        let pcm = Data([0x01, 0x00, 0xFF, 0x7F])
        let file = WAVFile.data(pcm16: pcm, sampleRate: 16_000)

        XCTAssertEqual(file.count, WAVFile.headerBytes + pcm.count)
        XCTAssertEqual(String(data: file[0 ..< 4], encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: file[8 ..< 12], encoding: .ascii), "WAVE")
        XCTAssertEqual(String(data: file[12 ..< 16], encoding: .ascii), "fmt ")
        XCTAssertEqual(String(data: file[36 ..< 40], encoding: .ascii), "data")

        XCTAssertEqual(integer(in: file, at: 4, bytes: 4), UInt32(36 + pcm.count), "RIFF chunk size")
        XCTAssertEqual(integer(in: file, at: 16, bytes: 4), 16, "PCM format chunk length")
        XCTAssertEqual(integer(in: file, at: 20, bytes: 2), 1, "Uncompressed PCM")
        XCTAssertEqual(integer(in: file, at: 22, bytes: 2), 1, "Mono")
        XCTAssertEqual(integer(in: file, at: 24, bytes: 4), 16_000)
        XCTAssertEqual(integer(in: file, at: 28, bytes: 4), 32_000, "Byte rate: 16 kHz × 2 bytes")
        XCTAssertEqual(integer(in: file, at: 32, bytes: 2), 2, "Block align")
        XCTAssertEqual(integer(in: file, at: 34, bytes: 2), 16, "Bits per sample")
        XCTAssertEqual(integer(in: file, at: 40, bytes: 4), UInt32(pcm.count), "Data chunk length")
        XCTAssertEqual(file.suffix(pcm.count), pcm)
    }

    // MARK: - When nothing comes back

    /// The hallucination guard (Whisper-family models fabricating short boilerplate — "Thank
    /// you.", " you" — on near-silent audio) moved server-side with everything else in
    /// `DictationVocabulary`/`DictationSilence`: `server/app/tutor/vocabulary.py`'s `is_silence`
    /// is what decides this now, covered by `server/tests/test_dictation.py`'s own
    /// `test_boilerplate_transcripts_are_treated_as_silence`. What the client still owns is
    /// treating an empty final reading as "nothing to show" — see
    /// `testADoneEventWithEmptyTextOverridesWhateverTheDeltasShowed` above and the test below.
    func testAnEmptyResultIsALineAboveTheComposerRatherThanAnAlert() async {
        let field = ComposerField("I think")
        // The server has already judged this boilerplate and emptied `done`'s text — see
        // `BackendDictationReader`'s own doc comment on why an empty `done` is authoritative
        // rather than something to ignore. A real service never hands the controller "Thank
        // you." as a *final* reading any more; only an empty one.
        let service = ScriptedDictationService(script: [
            DictationTranscript(text: "", isFinal: true),
        ])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await controller.session?.value

        XCTAssertEqual(controller.note, .empty)
        XCTAssertEqual(controller.noteText, "I didn't catch anything that time.")
        XCTAssertNil(controller.notice, "Nothing said is not a failure, and not a modal.")
        XCTAssertEqual(field.text, "I think", "The fabrication never reaches the field.")
    }

    func testAFailedTranscriptionIsAlsoALineRatherThanAnAlert() async {
        let field = ComposerField()
        let service = ScriptedDictationService(script: [])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { controller.isListening })
        service.failInFlight(.recognitionFailed)
        await controller.session?.value

        XCTAssertEqual(controller.note, .failed)
        XCTAssertNil(controller.notice)
        for text in [DictationNote.empty.text, DictationNote.failed.text] {
            XCTAssertFalse(text.contains("error"), "The student is told what happened, not what failed.")
        }
    }

    func testTheNoteClearsOnTheNextTapAndNotOnATimer() async {
        let field = ComposerField()
        let service = ScriptedDictationService(script: [])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { controller.isListening })
        service.yield(DictationTranscript(text: "", isFinal: true))
        await controller.session?.value
        XCTAssertEqual(controller.note, .empty)

        controller.toggle(text: field.binding)
        XCTAssertNil(controller.note)
        // The second session has to be *running* before it can be cancelled. `toggle` only
        // schedules the task, so a `cancel()` in the same turn of the main actor arrives before
        // `run()` has called `start()` — there is no continuation to finish yet, and `run()`
        // then clears `isCancelled` on its way into a stream that never ends. Waiting for
        // `isListening` is waiting for the microphone the cancel is about.
        await settle(until: { controller.isListening })
        controller.cancel()
        await controller.session?.value
    }

    // MARK: - The meter

    /// The one indicator in the product whose motion is caused by the thing it reports — and,
    /// since App Store guideline 2.5.14 obliges the *app* to show that it is recording, the one
    /// that discharges it.
    func testSilenceDrawsFiveDotsAndSpeechDrawsBars() {
        let metrics = LevelMeterMetrics.panel

        let atRest = metrics.heights(for: 0)
        XCTAssertEqual(atRest.count, LevelMeterMetrics.barCount)
        XCTAssertTrue(
            atRest.allSatisfy { $0 == metrics.minimumHeight },
            "At silence every bar is its own width — a circle, which is state/thinking's dot."
        )
        XCTAssertEqual(metrics.minimumHeight, metrics.barWidth)

        let loud = metrics.heights(for: 1)
        XCTAssertEqual(loud[2], metrics.maximumHeight, "The middle bar reaches the line box and no further.")
        XCTAssertTrue(loud.allSatisfy { $0 <= metrics.maximumHeight })
        XCTAssertEqual(loud[0], loud[4], "Symmetric about the middle.")
        XCTAssertGreaterThan(loud[1], loud[0])

        // 5 × 6 + 4 × 8 = 62 · 5 × 8 + 4 × 12 = 88
        XCTAssertEqual(metrics.width, 62)
        XCTAssertEqual(LevelMeterMetrics.fullScreen.width, 88)
        XCTAssertEqual(metrics.maximumHeight, DS.Leading.body)
        XCTAssertEqual(LevelMeterMetrics.fullScreen.maximumHeight, DS.Leading.lead)
    }

    func testLoudnessIsReadInDecibelsRatherThanRawAmplitude() {
        XCTAssertEqual(DictationLevel.level(rms: 0), 0)
        XCTAssertEqual(DictationLevel.level(rms: 1), 1, accuracy: 0.001)
        // −50 dBFS is the floor: a quiet room reads as silence rather than as a twitching bar.
        XCTAssertEqual(DictationLevel.level(rms: pow(10, -50 / 20.0)), 0, accuracy: 0.001)
        // Half the travel is −25 dBFS, not amplitude 0.5 — which is what makes ordinary speech
        // move the meter at all.
        XCTAssertEqual(DictationLevel.level(rms: pow(10, -25 / 20.0)), 0.5, accuracy: 0.001)
        XCTAssertGreaterThan(DictationLevel.level(rms: 0.5), 0.8)

        // Fast up, slow down: a bar rises with the syllable and falls back over a few frames.
        XCTAssertGreaterThan(DictationLevel.attack, DictationLevel.release)
        XCTAssertEqual(DictationLevel.smoothed(0, towards: 1), DictationLevel.attack, accuracy: 0.001)
        XCTAssertEqual(DictationLevel.smoothed(1, towards: 0), 1 - DictationLevel.release, accuracy: 0.001)
    }

    /// Board 15's own values, including the two marks it specified at 740 for the first time.
    func testTheMarksTheseStatesAreMadeOfCarryBoardFifteensValues() {
        XCTAssertEqual(ComposerMetrics.panel.cancelGlyphSize, 22)
        XCTAssertEqual(ComposerMetrics.fullScreen.cancelGlyphSize, 26)
        XCTAssertEqual(ComposerMetrics.minimumTapTarget, 44, "Apple's stated default target.")
        XCTAssertGreaterThanOrEqual(
            ComposerMetrics.minimumTapTarget,
            ComposerMetrics.panel.voiceButtonSize,
            "The panel's 38pt mic is drawn at 38 and tapped at 44."
        )

        XCTAssertEqual(ThinkingIndicator.dotSize(at: .panel), 6)
        XCTAssertEqual(ThinkingIndicator.dotSize(at: .fullScreen), 8)
        XCTAssertEqual(ThinkingIndicator.gap(at: .panel), DS.Space.s2)
        XCTAssertEqual(ThinkingIndicator.gap(at: .fullScreen), DS.Space.s3)
        XCTAssertEqual(StreamingCaret.height(at: .panel), DS.Leading.control)
        XCTAssertEqual(StreamingCaret.height(at: .fullScreen), 26)

        XCTAssertEqual(ComposerMetrics.noteStyle.size, DS.Size.label)
        XCTAssertEqual(ComposerMetrics.noteStyle.leading, DS.Leading.label)
        XCTAssertEqual(ComposerMetrics.noteGap, DS.Space.s3)
    }

    /// The cap is only a warning if it is visible, and it is the elapsed label that shows it.
    func testTheElapsedLabelCountsInMinutesAndSeconds() {
        XCTAssertEqual(ElapsedLabel.text(for: 0), "0:00")
        XCTAssertEqual(ElapsedLabel.text(for: 7.4), "0:07")
        XCTAssertEqual(ElapsedLabel.text(for: 59), "0:59")
        XCTAssertEqual(ElapsedLabel.text(for: BackendDictationService.captureLimit), "1:00")
        XCTAssertEqual(ElapsedLabel.text(for: -3), "0:00")
    }

    // MARK: - The session id

    /// `server/app/api/dictation.py` 404s an unknown `session_id` — the wiring this test pins,
    /// so a fresh id minted somewhere rather than the store's real one fails silently instead
    /// of loudly.
    func testTheControllerThreadsItsSessionIDIntoTheServicesStart() async {
        let field = ComposerField()
        let service = ScriptedDictationService(script: [DictationTranscript(text: "ok", isFinal: true)])
        let controller = DictationController(service: service)
        let sessionID = UUID()
        controller.sessionID = sessionID

        controller.toggle(text: field.binding)
        await controller.session?.value

        XCTAssertEqual(service.lastSessionID, sessionID)
    }

    // MARK: - Fixtures

    /// The composer as both call sites build it, so what is asserted is the production seam
    /// rather than a rehearsal of it.
    private func composer(voice: (() -> Void)?) -> Composer {
        Composer(scale: .panel, text: .constant(""), onSend: {}, onVoice: voice)
    }

    /// Lets the controller's session task run until `condition` holds. Polling `Task.yield()`
    /// rather than sleeping: the session is main-actor work, so it makes progress every time
    /// this test hands the actor back, and there is no duration to guess at.
    private func settle(
        until condition: () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0 ..< 500 {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("The dictation session never reached the expected state", file: file, line: line)
    }

    /// A `BackendConfiguration` naming the same fixture host/token every dictation network test
    /// uses, so a stubbed request's shape can be asserted without rebuilding one per test — the
    /// same fixture-configuration shape `BackendTutorServiceTests` builds inline.
    nonisolated static let backendConfiguration = BackendConfiguration(
        baseURL: URL(string: "https://backend.example.com")!,
        token: "test-token"
    )!

    /// Every reading a server-sent-event body produces, in order, through the real streaming
    /// path (`bytes(for:)`, line splitting, a body that stops halfway) with only the socket
    /// replaced — `StubURLProtocol`, the same seam `BackendTutorServiceTests` drives.
    private func transcripts(from body: String) async throws -> [DictationTranscript] {
        StubURLProtocol.reset()
        StubURLProtocol.body = body
        return try await collect(BackendDictationClient(configuration: Self.backendConfiguration, session: StubURLProtocol.stubbedSession))
    }

    private func collect(_ client: BackendDictationClient) async throws -> [DictationTranscript] {
        var readings: [DictationTranscript] = []
        for try await reading in client.readings(for: WAVFile.data(pcm16: Data([0x00, 0x00])), sessionID: UUID()) {
            readings.append(reading)
        }
        return readings
    }

    /// A little-endian field of the WAV header, as a number.
    private func integer(in data: Data, at offset: Int, bytes: Int) -> UInt32 {
        data[offset ..< offset + bytes]
            .enumerated()
            .reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * $1.offset) }
    }
}

/// The composer's text, standing in for the `@State` `BoardScreen` owns.
@MainActor
private final class ComposerField {
    var text: String

    init(_ text: String = "") {
        self.text = text
    }

    var binding: Binding<String> {
        Binding(get: { self.text }, set: { self.text = $0 })
    }
}
