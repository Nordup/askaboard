import AVFAudio
import SwiftUI
import XCTest
import os
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

    /// The first-run state: no key, so no dictation and — the part that matters — no mic in the
    /// composer rather than one that can only ever raise a notice.
    func testWithoutAKeyThereIsNoDictationAndNoMicrophoneToTap() {
        let noKey: @Sendable () -> String? = { nil }
        // Whitespace counts as absent, the same rule `TutorServiceRouter` applies to the tutor.
        let blankKey: @Sendable () -> String? = { "   " }

        for reader in [noKey, blankKey] {
            let service = OpenAIDictationService(apiKeyReader: reader)

            XCTAssertFalse(service.isSupported)
            XCTAssertEqual(service.availability, .unavailable)

            let controller = DictationController(service: service)
            XCTAssertNil(
                composer(voice: controller.voiceHandler(text: ComposerField().binding)).onVoice,
                "A composer with no key gets the design's other composer, not a dead button."
            )
        }
    }

    /// The other side of the same rule: a key is the whole of what makes the mic appear. What
    /// the permission then says is the microphone's business, and never `.unavailable`.
    func testAKeyIsWhatPutsTheMicrophoneInTheComposer() {
        let service = OpenAIDictationService(apiKeyReader: { "sk-test-key" })

        XCTAssertTrue(service.isSupported)
        XCTAssertNotEqual(service.availability, .unavailable)
        XCTAssertNotNil(
            composer(voice: DictationController(service: service).voiceHandler(text: ComposerField().binding)).onVoice
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

    func testTheTranscriptionRequestIsTheOneTheEndpointDocuments() throws {
        let audio = Data("RIFFfake".utf8)
        let request = try XCTUnwrap(
            OpenAITranscriptionRequestBuilder.urlRequest(audio: audio, apiKey: "sk-test", boundary: "BOUNDARY")
        )

        XCTAssertEqual(request.url?.absoluteString, "https://api.openai.com/v1/audio/transcriptions")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer sk-test")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Content-Type"),
            "multipart/form-data; boundary=BOUNDARY"
        )

        let body = try XCTUnwrap(request.httpBody)
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        XCTAssertTrue(text.contains("name=\"model\"\r\n\r\ngpt-transcribe\r\n"))
        XCTAssertTrue(text.contains("name=\"stream\"\r\n\r\ntrue\r\n"), "Partial text has to flow while it transcribes.")
        XCTAssertTrue(text.contains("name=\"prompt\"\r\n\r\n\(DictationVocabulary.sanitised(DictationVocabulary.prompt))\r\n"))
        // One part per value: a joined list would need a separator, and every plausible
        // separator is either rejected by the endpoint or appears inside a keyword.
        XCTAssertTrue(text.contains("name=\"keywords\"\r\n\r\nsine\r\n"))
        XCTAssertTrue(text.contains("name=\"keywords\"\r\n\r\nsolve for x\r\n"))
        XCTAssertEqual(
            text.components(separatedBy: "name=\"keywords\"").count - 1,
            DictationVocabulary.wireKeywords.count
        )
        XCTAssertTrue(text.contains("name=\"languages\"\r\n\r\nen\r\n"))
        XCTAssertTrue(text.contains("name=\"file\"; filename=\"speech.wav\""))
        XCTAssertTrue(text.contains("Content-Type: audio/wav"))
        XCTAssertTrue(text.contains("RIFFfake"))
        XCTAssertTrue(text.hasSuffix("--BOUNDARY--\r\n"))
    }

    /// The audio is bytes, not text, and a multipart builder that goes through `String`
    /// anywhere would quietly mangle it.
    func testTheAudioSurvivesTheMultipartBodyByteForByte() throws {
        let audio = Data([0x00, 0xFF, 0xFE, 0x80, 0x0A, 0x0D])
        let body = OpenAITranscriptionRequestBuilder.multipartBody(audio: audio, boundary: "B")

        XCTAssertNotNil(body.range(of: audio))
    }

    /// The two instruments the endpoint separates: `keywords` for the terms, `prompt` for the
    /// situation. Putting the term list in `prompt` — as an earlier build did — leaves the
    /// parameter that `gpt-transcribe` was chosen for unused.
    func testTheVocabularyIsKeywordsAndThePromptIsOnlyTheSituation() {
        for term in ["sine", "cosine", "square root", "radical", "denominator", "hypotenuse"] {
            XCTAssertTrue(
                DictationVocabulary.keywords.contains(term),
                "\(term) is one of the words this list exists for."
            )
        }
        XCTAssertFalse(
            DictationVocabulary.prompt.contains("cosine"),
            "Terms belong in keywords; the prompt is the situation."
        )
        XCTAssertLessThan(
            DictationVocabulary.prompt.count,
            300,
            "Past a certain length the prompt stops biasing spelling and starts writing the transcript."
        )
        XCTAssertEqual(DictationVocabulary.languages, ["en"], "Stated, not detected.")
    }

    /// The endpoint rejects the **entire request** over a `<`, `>`, carriage return or line
    /// feed in `prompt` or a keyword — it does not drop the parameter, it loses the student's
    /// recording. So the guard runs before the request is built.
    func testTheRejectionCharactersNeverReachTheWire() {
        XCTAssertEqual(DictationVocabulary.sanitised("solve for x\nsquare root"), "solve for x square root")
        XCTAssertEqual(DictationVocabulary.sanitised("a < b > c"), "a b c")
        XCTAssertEqual(DictationVocabulary.sanitised("carriage\r\nreturn"), "carriage return")

        for value in DictationVocabulary.wireKeywords + [DictationVocabulary.sanitised(DictationVocabulary.prompt)] {
            XCTAssertFalse(value.contains("<"), value)
            XCTAssertFalse(value.contains(">"), value)
            XCTAssertFalse(value.contains("\n"), value)
            XCTAssertFalse(value.contains("\r"), value)
            XCTAssertFalse(value.isEmpty)
        }
    }

    // MARK: - The streamed response

    func testDeltasAccumulateIntoARunningTranscriptAndTheDoneEventCompletesIt() async throws {
        let transcript = try await transcripts(from: """
            data: {"type":"transcript.text.delta","delta":"why does "}

            data: {"type":"transcript.text.delta","delta":"sine "}

            data: {"type":"transcript.text.done","text":"Why does sine repeat?"}

            data: [DONE]

            """)

        XCTAssertEqual(transcript.map(\.text), ["why does ", "why does sine ", "Why does sine repeat?"])
        XCTAssertEqual(transcript.map(\.isFinal), [false, false, true])
        XCTAssertTrue(transcript.allSatisfy { $0.phase == .transcribing })
    }

    /// The connection drops mid-sentence. The composer must not sit waiting for a rest of it
    /// that is never coming.
    func testATruncatedStreamFailsCleanlyRatherThanHanging() async {
        do {
            _ = try await transcripts(from: """
                data: {"type":"transcript.text.delta","delta":"why does "}

                data: {"type":"transcript.text.de
                """)
            XCTFail("A stream that never says it is done is a failure, not a completed transcript.")
        } catch {
            XCTAssertEqual(error as? DictationError, .recognitionFailed)
        }
    }

    func testTheReaderSkipsEveryLineThatIsNotATranscriptFrame() {
        var reader = OpenAITranscriptionReader()

        XCTAssertNil(reader.read(""))
        XCTAssertNil(reader.read(": keep-alive"))
        XCTAssertNil(reader.read("event: transcript.text.delta"))
        XCTAssertNil(reader.read("data: [DONE]"))
        XCTAssertNil(reader.read("data: {this is not json"))
        XCTAssertNil(reader.read(#"data: {"type":"transcript.text.delta"}"#), "A delta with no delta in it.")
        XCTAssertNil(reader.read(#"data: {"type":"speech.started"}"#))
        XCTAssertEqual(reader.text, "")
        XCTAssertFalse(reader.isComplete)

        XCTAssertEqual(reader.read(#"data: {"type":"transcript.text.done","text":"ok"}"#)?.text, "ok")
        XCTAssertTrue(reader.isComplete)
        XCTAssertNil(reader.read(#"data: {"type":"transcript.text.delta","delta":" more"}"#), "Nothing follows done.")
    }

    // MARK: - Failure

    /// 401, 429 and 500 all end the same way for the student, and none of them can put the
    /// provider's words on screen: the body is never read, and `DictationError` has no room to
    /// carry one.
    func testAnHttpFailureBecomesAFixedSentenceThatQuotesNothingTheStudentSaid() async {
        let providerBody = """
            {"error":{"message":"Incorrect API key provided: sk-live-9BQ. Audio: 'the answer is twelve'."}}
            """

        for status in [401, 429, 500] {
            StubTranscriptionProtocol.response.withLock {
                $0 = StubTranscriptionProtocol.Reply(status: status, body: Data(providerBody.utf8))
            }
            do {
                _ = try await collect(OpenAITranscriptionClient(apiKey: "sk-test", session: stubbedSession()))
                XCTFail("HTTP \(status) is not a transcript.")
            } catch {
                XCTAssertEqual(error as? DictationError, OpenAITranscriptionClient.failure(status: status))
            }
        }

        // A credential the provider refuses is the same answer as having no key: nothing about
        // this session works until it changes. The rest is worth another tap.
        XCTAssertEqual(OpenAITranscriptionClient.failure(status: 401), .unavailable)
        XCTAssertEqual(OpenAITranscriptionClient.failure(status: 403), .unavailable)
        XCTAssertEqual(OpenAITranscriptionClient.failure(status: 429), .recognitionFailed)
        XCTAssertEqual(OpenAITranscriptionClient.failure(status: 500), .recognitionFailed)

        for message in [
            DictationNotice.permission.message,
            DictationNotice.unavailable.message,
            DictationNote.empty.text,
            DictationNote.failed.text
        ] {
            XCTAssertFalse(message.contains("sk-live"))
            XCTAssertFalse(message.contains("twelve"))
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

        service.failInFlight(OpenAITranscriptionClient.failure(status: 500))
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

        XCTAssertEqual(OpenAIDictationService.captureLimit, 60)
        XCTAssertLessThan(
            OpenAIDictationService.byteLimit(sampleRate: 16_000) + WAVFile.headerBytes,
            endpointLimit / 10,
            "A minute at 16 kHz mono is under a tenth of the ceiling."
        )
        XCTAssertLessThan(
            OpenAIDictationService.byteLimit(sampleRate: 48_000) + WAVFile.headerBytes,
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

    /// `isEmpty` is not a sufficient guard. Whisper-family models fabricate on near-silent
    /// audio — a child who taps, hesitates and taps again can plausibly be handed a confident
    /// "Thank you." — so short caption boilerplate is treated as silence and never written into
    /// the composer as if the student had said it.
    func testTheDocumentedHallucinationsAreTreatedAsSilence() {
        for fabrication in ["", "   ", "you", " you", "Thank you.", "thank you", "Thanks for watching!", "Please subscribe", "Subtitles by the Amara.org community", "Bye."] {
            XCTAssertTrue(DictationSilence.isSilence(fabrication), "\(fabrication) is a documented empty-audio artefact")
        }
    }

    /// And the guard must not eat real speech. Anything longer than the boilerplate limit is
    /// the student's, and the composer-review step is what catches the rest.
    func testTheSilenceGuardNeverSwallowsSomethingTheStudentSaid() {
        for said in [
            "why does sine repeat?",
            "thank you for explaining, but why is it negative?",
            "x squared",
            "no",
            "1 over x plus 2",
            "thanks, I get it now"
        ] {
            XCTAssertFalse(DictationSilence.isSilence(said), said)
        }
    }

    func testAnEmptyResultIsALineAboveTheComposerRatherThanAnAlert() async {
        let field = ComposerField("I think")
        let service = ScriptedDictationService(script: [])
        let controller = DictationController(service: service)

        controller.toggle(text: field.binding)
        await settle(until: { controller.isListening })
        service.yield(DictationTranscript(text: "Thank you.", isFinal: true))
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

    // MARK: - Retrying, and not retrying

    func testTheFailuresWorthAnotherAttemptAreTheOnesAWaitCanFix() {
        XCTAssertTrue(OpenAITranscriptionClient.isRetryable(status: 429))
        XCTAssertTrue(OpenAITranscriptionClient.isRetryable(status: 500))
        XCTAssertTrue(OpenAITranscriptionClient.isRetryable(status: 503))
        XCTAssertFalse(OpenAITranscriptionClient.isRetryable(status: 401), "A key does not fix itself.")
        XCTAssertFalse(OpenAITranscriptionClient.isRetryable(status: 400), "A malformed request is a bug.")
    }

    /// Waiting cannot buy credit. Retrying a spend-limit 429 is pure latency in front of a
    /// failure that will not change, and it reads to the student as a hang.
    func testABillingRefusalIsNeverRetried() {
        let body = Data(#"{"error":{"message":"You have exhausted your credits.","code":"credit_balance_exhausted"}}"#.utf8)

        XCTAssertEqual(OpenAITranscriptionClient.errorCode(fromBody: body), "credit_balance_exhausted")
        XCTAssertTrue(OpenAITranscriptionClient.terminalBillingCodes.contains("credit_balance_exhausted"))
        XCTAssertTrue(OpenAITranscriptionClient.terminalBillingCodes.contains("project_spend_limit_exceeded"))
        XCTAssertNil(OpenAITranscriptionClient.errorCode(fromBody: Data("not json".utf8)))
    }

    func testRetryAfterIsFollowedWhenItIsPresentAndSaneWhenItIsNot() throws {
        func response(retryAfter: String?) throws -> HTTPURLResponse {
            let url = try XCTUnwrap(URL(string: OpenAITranscriptionRequestBuilder.endpoint))
            return try XCTUnwrap(HTTPURLResponse(
                url: url,
                statusCode: 429,
                httpVersion: "HTTP/1.1",
                headerFields: retryAfter.map { ["Retry-After": $0] } ?? [:]
            ))
        }

        XCTAssertEqual(OpenAITranscriptionClient.retryDelay(from: try response(retryAfter: "2")), 2)
        XCTAssertNil(OpenAITranscriptionClient.retryDelay(from: try response(retryAfter: nil)))
        XCTAssertNil(OpenAITranscriptionClient.retryDelay(from: try response(retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT")))
        XCTAssertEqual(
            OpenAITranscriptionClient.retryDelay(from: try response(retryAfter: "600")),
            10,
            "A provider asking for ten minutes is a failure, not a pause."
        )
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
        XCTAssertEqual(ElapsedLabel.text(for: OpenAIDictationService.captureLimit), "1:00")
        XCTAssertEqual(ElapsedLabel.text(for: -3), "0:00")
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

    /// A session that answers every request from `StubTranscriptionProtocol` instead of the
    /// network — the same value-only discipline the tutor's request tests use, extended to the
    /// one thing that cannot be a pure function: a response that arrives in pieces.
    private func stubbedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubTranscriptionProtocol.self]
        return URLSession(configuration: configuration)
    }

    /// Every reading a server-sent-event body produces, in order.
    private func transcripts(from body: String) async throws -> [DictationTranscript] {
        StubTranscriptionProtocol.response.withLock {
            $0 = StubTranscriptionProtocol.Reply(status: 200, body: Data(body.utf8))
        }
        return try await collect(OpenAITranscriptionClient(apiKey: "sk-test", session: stubbedSession()))
    }

    private func collect(_ client: OpenAITranscriptionClient) async throws -> [DictationTranscript] {
        var readings: [DictationTranscript] = []
        for try await reading in client.readings(for: WAVFile.data(pcm16: Data([0x00, 0x00]))) {
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

/// The provider, replaced by whatever the test wants it to have said.
///
/// A `URLProtocol` rather than a protocol seam over `URLSession`, because what is under test
/// includes the streaming itself: `bytes(for:)`, the line splitting and a body that stops
/// halfway are all real here, and only the socket is not.
private final class StubTranscriptionProtocol: URLProtocol {
    struct Reply: Sendable {
        let status: Int
        let body: Data
    }

    /// A lock rather than a bare `static var`: the loading system reads this off its own queue,
    /// and this project does not have `nonisolated(unsafe)` in it anywhere.
    static let response = OSAllocatedUnfairLock<Reply?>(initialState: nil)

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let reply = Self.response.withLock { $0 } ?? Reply(status: 200, body: Data())
        if let url = request.url,
           let response = HTTPURLResponse(
               url: url,
               statusCode: reply.status,
               httpVersion: "HTTP/1.1",
               headerFields: ["Content-Type": "text/event-stream"]
           ) {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        if !reply.body.isEmpty {
            client?.urlProtocol(self, didLoad: reply.body)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
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
