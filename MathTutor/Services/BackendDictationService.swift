import AVFAudio
import AudioToolbox
import Foundation
import os

/// Dictation as two halves, the same split `OpenAIDictationService` used before it:
/// `AVAudioEngine` records what the student says, and — the only thing that changed — the
/// finished recording is now handed to Math Tutor's own backend instead of OpenAI directly.
///
/// The wire contract below mirrors that service exactly: see `server/app/api/dictation.py` for
/// the endpoint, its multipart field names (`audio`, `session_id`) and its required
/// `session_id` (an id the server has never seen creates the session rather than failing —
/// dictating before typing anything is the normal first move), and `server/app/tutor/events.py` /
/// `DictationTextDeltaEvent`/`DictationDoneEvent` declared alongside the endpoint in
/// `dictation.py` for the event vocabulary this decodes. Do not change field or event names
/// here without re-reading those first.
///
/// Everything about the recording itself — the engine, the tap, the meter, the one-minute cap,
/// the WAV container — is unchanged from the OpenAI-era service; only the destination of the
/// finished bytes is different. Keyword steering, prompt sanitisation, retry policy, and the
/// boilerplate-silence guard all moved server-side with it (`server/app/tutor/vocabulary.py`,
/// `server/app/tutor/retry.py`) and have no client-side equivalent any more.
@MainActor
final class BackendDictationService: DictationService {
    /// See `OpenAIDictationService.captureLimit`'s reasoning, unchanged: the endpoint this now
    /// proxies to still rejects files over 25 MB, and a minute at 16 kHz mono is about a tenth
    /// of that.
    nonisolated static let captureLimit: TimeInterval = 60

    /// The recording's whole allocation, taken once before the engine starts so the audio
    /// thread never grows a buffer.
    nonisolated static func byteLimit(sampleRate: Double) -> Int {
        Int(captureLimit * sampleRate) * (WAVFile.bitsPerSample / 8)
    }

    private let configuration: BackendConfiguration
    private let session: URLSession
    private let engine = AVAudioEngine()
    /// What the route actually recorded at, which is what the WAV header has to say.
    private var captureSampleRate = Double(WAVFile.sampleRate)

    /// The one value the main actor and CoreAudio's render thread both touch. See
    /// `OpenAIDictationService`'s own doc comment on this lock for why it exists.
    private let recording = OSAllocatedUnfairLock<Recording?>(uncheckedState: nil)

    private var continuation: AsyncThrowingStream<DictationTranscript, any Error>.Continuation?
    private var transcription: Task<Void, Never>?
    private var ceiling: Task<Void, Never>?
    private var isCapturing = false
    /// Captured once at `start(sessionID:)` and read again in `stop()`, when the recording
    /// actually uploads: a session does not change in the middle of one recording, so one
    /// value for the whole capture is enough.
    private var sessionID = UUID()

    var inputLevel: Double { recording.withLockUnchecked { $0?.level ?? 0 } }

    init(configuration: BackendConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    /// A constructed instance always has a configuration — deciding whether one exists at all
    /// is `DictationServiceRouter`'s job, the same split `TutorServiceRouter`/
    /// `BackendTutorService` already use for the tutor.
    var isSupported: Bool { true }

    var availability: DictationAvailability {
        .resolve(microphone: AVAudioApplication.shared.recordPermission, hasCredential: true)
    }

    func requestAuthorization() async -> DictationAvailability {
        if AVAudioApplication.shared.recordPermission == .undetermined {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        return availability
    }

    func start(sessionID: UUID) throws -> AsyncThrowingStream<DictationTranscript, any Error> {
        cancel()
        self.sessionID = sessionID

        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            // Asking the route itself for 16 kHz is what keeps the tap's work to a format
            // change and not a resample — see `OpenAIDictationService.start()`'s longer note.
            try? audioSession.setPreferredSampleRate(Double(WAVFile.sampleRate))
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            throw DictationError.audioUnavailable
        }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        // A route with no sample rate is a device with no microphone attached — the
        // simulator's usual state. Installing a tap on it traps inside CoreAudio, so this is
        // the difference between the "dictation isn't available" notice and a crash.
        guard inputFormat.sampleRate > 0 else {
            deactivateSession()
            throw DictationError.audioUnavailable
        }

        guard let uploadFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: inputFormat.sampleRate,
            channels: 1,
            interleaved: true
        ), let converter = AVAudioConverter(from: inputFormat, to: uploadFormat) else {
            deactivateSession()
            throw DictationError.audioUnavailable
        }

        captureSampleRate = inputFormat.sampleRate
        recording.withLockUnchecked {
            $0 = Recording(
                converter: converter,
                format: uploadFormat,
                byteLimit: Self.byteLimit(sampleRate: inputFormat.sampleRate)
            )
        }

        let recording = self.recording
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { @Sendable buffer, _ in
            recording.withLockUnchecked { $0?.append(buffer) }
        }

        let (stream, continuation) = AsyncThrowingStream<DictationTranscript, any Error>.makeStream()
        self.continuation = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.cancel() }
        }
        // Set before the engine starts so the failure below tears the tap back down through
        // the one path that knows how.
        isCapturing = true

        do {
            engine.prepare()
            try engine.start()
        } catch {
            cancel()
            throw DictationError.audioUnavailable
        }

        ceiling = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.captureLimit))
            guard !Task.isCancelled else { return }
            self?.stop()
        }
        Self.playEarcon(.start)
        return stream
    }

    /// The student has finished speaking. The microphone closes here; the stream stays open
    /// for as long as the upload and transcription take.
    func stop() {
        guard isCapturing, let continuation else { return }
        let audio = endCapture()

        // Nothing was said, or the tap never delivered a buffer. Not a failure and not worth a
        // round trip — the composer simply holds what it held before.
        guard !audio.isEmpty else {
            continuation.finish()
            self.continuation = nil
            return
        }

        // Says the microphone has closed before the first word can possibly arrive, so the
        // composer can change what it is showing at the moment the student stops talking
        // rather than a second later.
        continuation.yield(DictationTranscript(text: "", isFinal: false, phase: .transcribing))

        let client = BackendDictationClient(configuration: configuration, session: session)
        let file = WAVFile.data(pcm16: audio, sampleRate: Int(captureSampleRate))
        let sessionID = self.sessionID
        // Captures the continuation, the client and the session id, and nothing of `self`: the
        // upload is not the service's state, and cancelling the task is the only hold it needs
        // to keep.
        transcription = Task {
            do {
                for try await reading in client.readings(for: file, sessionID: sessionID) {
                    continuation.yield(reading)
                    if reading.isFinal { break }
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: (error as? DictationError) ?? .recognitionFailed)
            }
        }
    }

    /// Everything a session allocates, released in the reverse of the order it was taken, and
    /// safe to run twice — see `OpenAIDictationService.cancel()`'s own note on this.
    func cancel() {
        ceiling?.cancel()
        ceiling = nil
        if isCapturing { _ = endCapture() }
        transcription?.cancel()
        transcription = nil

        let continuation = self.continuation
        self.continuation = nil
        continuation?.finish()
    }

    /// Closes the microphone and takes the recording out of the lock. Never writes it anywhere
    /// on-device: the audio exists as one `Data` in memory, is handed to one request, and is
    /// released with the request. Where it ends up after that is the backend's decision, not
    /// this method's — see `server/app/api/dictation.py`'s `persist_dictation_audio`.
    private func endCapture() -> Data {
        isCapturing = false
        ceiling?.cancel()
        ceiling = nil

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        let audio = recording.withLockUnchecked { state -> Data in
            let samples = state?.samples ?? Data()
            state = nil
            return samples
        }

        deactivateSession()
        Self.playEarcon(.stop)
        return audio
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The sounds at the two ends of a recording. See `OpenAIDictationService.Earcon`'s doc
    /// comment for the guidance behind these — unchanged here.
    enum Earcon: SystemSoundID {
        case start = 1113
        case stop = 1114
    }

    nonisolated static func playEarcon(_ earcon: Earcon) {
        AudioServicesPlaySystemSound(earcon.rawValue)
    }
}

// MARK: - What the audio thread writes into

/// The recording, in the format it will be uploaded in. Provider-agnostic — unchanged from
/// `OpenAIDictationService`'s own `Recording`, moved here because this is where capture now
/// lives.
private struct Recording {
    let converter: AVAudioConverter
    let format: AVAudioFormat
    /// Where the recording stops. Belongs to the recording rather than to the tap because the
    /// tap is called on a thread that must not be handed a decision to make.
    let byteLimit: Int
    private(set) var samples: Data
    /// The recording reached its ceiling. The tap stops appending immediately; the session is
    /// ended a moment later by the main actor, which is the side that can transcribe.
    private(set) var isFull = false

    /// How loud the last buffer was, 0…1, smoothed. See `DictationLevel` for the arithmetic.
    private(set) var level: Double = 0

    init(converter: AVAudioConverter, format: AVAudioFormat, byteLimit: Int) {
        self.converter = converter
        self.format = format
        self.byteLimit = byteLimit
        // The whole minute, allocated before the engine starts, so nothing the audio thread
        // does can grow this buffer.
        samples = Data(capacity: byteLimit)
    }

    mutating func append(_ buffer: AVAudioPCMBuffer) {
        guard !isFull, buffer.frameLength > 0 else { return }
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength) else { return }

        do {
            try converter.convert(to: converted, from: buffer)
        } catch {
            return
        }

        guard converted.frameLength > 0, let channel = converted.int16ChannelData else { return }
        let frames = UnsafeBufferPointer(start: channel[0], count: Int(converted.frameLength))
        level = DictationLevel.smoothed(level, towards: DictationLevel.level(rms: Self.rms(of: frames)))
        samples.append(frames)
        if samples.count >= byteLimit { isFull = true }
    }

    /// The buffer's root mean square, 0…1. RMS rather than peak because a meter should follow
    /// how loud the student *sounds*, not how loud one sample was.
    static func rms(of frames: UnsafeBufferPointer<Int16>) -> Double {
        guard !frames.isEmpty else { return 0 }
        var sumOfSquares = 0.0
        for frame in frames {
            let sample = Double(frame) / Double(Int16.max)
            sumOfSquares += sample * sample
        }
        return (sumOfSquares / Double(frames.count)).squareRoot()
    }
}

// MARK: - The meter's arithmetic

/// How an amplitude becomes a bar height, kept as values so it can be asserted on a machine
/// with no microphone — which is every machine this project's tests run on. Unchanged from
/// `OpenAIDictationService.DictationLevel`, moved here with the capture logic that uses it.
enum DictationLevel {
    /// Where the meter's floor sits. A quiet room is around −50 dBFS, so anything below it is
    /// silence as far as the bars are concerned and the meter rests as five dots.
    static let floorDecibels: Double = -50

    /// One-pole smoothing, fast up and slow down, so a bar rises with the syllable and falls
    /// back over a few frames instead of flickering once per buffer.
    static let attack: Double = 0.5
    static let release: Double = 0.15

    /// Decibels rather than raw amplitude because loudness is logarithmic: a linear bar spends
    /// its whole travel in the top of the range and reads as motionless for ordinary speech.
    static func level(rms: Double) -> Double {
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        return min(1, max(0, 1 - decibels / floorDecibels))
    }

    static func smoothed(_ current: Double, towards target: Double) -> Double {
        let coefficient = target > current ? attack : release
        return current + (target - current) * coefficient
    }
}

// MARK: - The upload

/// The half of a dictation session that has no microphone in it: audio and a session id in,
/// readings out. Separated from the capture half deliberately, the same split
/// `OpenAITranscriptionClient` used — this is the half a machine with no microphone can still
/// test end to end, and the simulator is such a machine.
///
/// Unlike `OpenAITranscriptionClient`, this makes exactly one request and never retries: the
/// retryable failures (429, 5xx from OpenAI) are now retried server-side, before the SSE
/// response to this client even opens (`server/app/api/dictation.py`, `_open_stream`) — a
/// second retry loop here would just be retrying an answer that has already been retried.
struct BackendDictationClient: Sendable {
    let configuration: BackendConfiguration
    let session: URLSession

    init(configuration: BackendConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    func readings(for audio: Data, sessionID: UUID) -> AsyncThrowingStream<DictationTranscript, any Error> {
        let (stream, continuation) = AsyncThrowingStream<DictationTranscript, any Error>.makeStream()
        let work = Task {
            do {
                try await run(audio: audio, sessionID: sessionID, into: continuation)
                continuation.finish()
            } catch let error as DictationError {
                continuation.finish(throwing: error)
            } catch {
                // Never the transport's own description: `DictationError` has no room to carry
                // one, and this is a child speaking.
                continuation.finish(throwing: DictationError.recognitionFailed)
            }
        }
        continuation.onTermination = { _ in work.cancel() }
        return stream
    }

    private func run(
        audio: Data,
        sessionID: UUID,
        into continuation: AsyncThrowingStream<DictationTranscript, any Error>.Continuation
    ) async throws {
        let request = BackendDictationRequestBuilder.urlRequest(
            audio: audio,
            sessionID: sessionID,
            configuration: configuration
        )
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw DictationError.recognitionFailed }
        guard (200 ..< 300).contains(http.statusCode) else {
            throw Self.failure(status: http.statusCode)
        }

        var reader = BackendDictationReader()
        for try await line in bytes.lines {
            switch reader.read(line) {
            case .transcript(let reading):
                continuation.yield(reading)
                if reading.isFinal { return }
            case .failure:
                // `server/app/api/dictation.py` never puts the provider's or its own
                // exception's message on the wire in a form worth keeping — `_describe_error`
                // strips it deliberately — so there is nothing here to carry forward either.
                throw DictationError.recognitionFailed
            case nil:
                continue
            }
        }
        // The connection ended before the server said `done` — a fragment of a sentence, not a
        // completed transcript. Failing is what stops the composer waiting for a rest of it
        // that is never coming; the words already delivered stay in the field to be edited.
        throw DictationError.recognitionFailed
    }

    /// An HTTP status, as one of the two failures the product knows how to say.
    ///
    /// 401/403 is the device token the app presents (`require_device_token`), refused — the
    /// same answer as having no credential at all, since nothing about this session will work
    /// until the build is repointed. Everything else — 429, a 5xx, a malformed request —
    /// is this attempt's problem and worth another tap.
    static func failure(status: Int) -> DictationError {
        (401 ... 403).contains(status) ? .unavailable : .recognitionFailed
    }
}

// MARK: - The request

/// Builds the multipart request without touching the network, so a test can inspect the exact
/// contract `server/app/api/dictation.py` documents: `audio` (the WAV, filename `speech.wav`,
/// `Content-Type: audio/wav`) and `session_id` (the form field the endpoint requires; the
/// session it names is created on the spot if it does not exist yet).
enum BackendDictationRequestBuilder {
    static let filename = "speech.wav"
    static let contentType = "audio/wav"

    static func multipartBody(audio: Data, sessionID: UUID, boundary: String) -> Data {
        var body = Data()
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"session_id\"\r\n\r\n")
        body.append("\(sessionID.uuidString)\r\n")

        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"\(filename)\"\r\n")
        body.append("Content-Type: \(contentType)\r\n\r\n")
        body.append(audio)
        body.append("\r\n--\(boundary)--\r\n")
        return body
    }

    /// `boundary` is a parameter rather than a private detail so a test can assert the body
    /// byte for byte. Callers take the default, which is a fresh one per request.
    static func urlRequest(
        audio: Data,
        sessionID: UUID,
        configuration: BackendConfiguration,
        boundary: String = UUID().uuidString
    ) -> URLRequest {
        let url = configuration.baseURL.appendingPathComponent("v1/dictation")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = multipartBody(audio: audio, sessionID: sessionID, boundary: boundary)
        return request
    }
}

// MARK: - The response

/// The streamed transcription, read one server-sent-event line at a time. A value type with no
/// network in it, mirroring `OpenAITranscriptionReader`'s own reasoning for being one.
///
/// **The deltas are appends, not revisions** — `DictationTextDeltaEvent.text` is the increment,
/// forwarded as OpenAI sent it (`server/app/api/dictation.py`'s own comment: *"matching how
/// `TextDeltaEvent` already works for `/v1/turn`"*), so this adds them up the same way the old
/// reader summed `transcript.text.delta`.
///
/// **`done` is authoritative even when empty.** The server intentionally sends an empty `text`
/// here when `is_silence` judged the whole recording boilerplate
/// (`final_text = "" if is_silence(text) else text`), overriding whatever partial words the
/// deltas already showed — unlike the OpenAI-direct reader this replaced, which only trusted a
/// *non-empty* `transcript.text.done`. Read that guard's absence as deliberate, not missed: an
/// empty `done` here is the server's silence verdict, not a glitch to protect against.
struct BackendDictationReader {
    private(set) var text = ""
    private(set) var isComplete = false

    enum Reading {
        case transcript(DictationTranscript)
        /// An `error` event — a truncated OpenAI stream, a persistence failure, or a
        /// provider failure that reached the server after its own retries. The caller
        /// converts this to `DictationError`; the message never crosses this boundary.
        case failure
    }

    /// The reading this line produced, or `nil` for a line that carried none: the blank
    /// separators between frames, SSE comments, and any frame whose JSON does not parse or
    /// whose `type` this client does not recognise.
    mutating func read(_ line: String) -> Reading? {
        guard !isComplete, let payload = Self.payload(of: line) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
              let type = object["type"] as? String else { return nil }

        switch type {
        case "text_delta":
            guard let delta = object["text"] as? String, !delta.isEmpty else { return nil }
            text += delta
            return .transcript(DictationTranscript(text: text, isFinal: false, phase: .transcribing))
        case "done":
            if let final = object["text"] as? String { text = final }
            isComplete = true
            return .transcript(DictationTranscript(text: text, isFinal: true, phase: .transcribing))
        case "error":
            isComplete = true
            return .failure
        default:
            // Unrecognised event type: ignore rather than fail the turn. The server may ship
            // new event types before this client knows about them.
            return nil
        }
    }

    /// The JSON of a `data:` frame, or `nil` for every other line SSE allows.
    static func payload(of line: String) -> String? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        guard !payload.isEmpty, payload != "[DONE]" else { return nil }
        return payload
    }
}

// MARK: - The container

/// A RIFF/WAVE wrapper for 16-bit little-endian PCM. Unchanged from `OpenAITranscription`'s own
/// `WAVFile`, moved here because it is provider-agnostic and the recording still needs it.
enum WAVFile {
    /// Speech carries no information above 8 kHz, so 16 kHz sampling is the whole of it.
    static let sampleRate = 16_000
    /// The canonical RIFF/WAVE header: everything before `data`'s payload.
    static let headerBytes = 44
    static let bitsPerSample = 16
    static let monoChannelCount = 1

    static func data(pcm16: Data, sampleRate: Int = sampleRate) -> Data {
        let blockAlign = monoChannelCount * bitsPerSample / 8
        let byteRate = sampleRate * blockAlign

        var file = Data()
        file.reserveCapacity(headerBytes + pcm16.count)
        file.append(ascii: "RIFF")
        file.append(littleEndian: UInt32(36 + pcm16.count))
        file.append(ascii: "WAVE")
        file.append(ascii: "fmt ")
        file.append(littleEndian: UInt32(16))
        file.append(littleEndian: UInt16(1))
        file.append(littleEndian: UInt16(monoChannelCount))
        file.append(littleEndian: UInt32(sampleRate))
        file.append(littleEndian: UInt32(byteRate))
        file.append(littleEndian: UInt16(blockAlign))
        file.append(littleEndian: UInt16(bitsPerSample))
        file.append(ascii: "data")
        file.append(littleEndian: UInt32(pcm16.count))
        file.append(pcm16)
        return file
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(Data(string.utf8))
    }

    mutating func append(ascii: String) {
        append(Data(ascii.utf8))
    }

    mutating func append(littleEndian value: UInt32) {
        append(contentsOf: [
            UInt8(value & 0xFF),
            UInt8((value >> 8) & 0xFF),
            UInt8((value >> 16) & 0xFF),
            UInt8((value >> 24) & 0xFF)
        ])
    }

    mutating func append(littleEndian value: UInt16) {
        append(contentsOf: [UInt8(value & 0xFF), UInt8((value >> 8) & 0xFF)])
    }
}
