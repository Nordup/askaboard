import Foundation

// MARK: - Vocabulary

/// What the transcriber is told about this recording before it hears any of it.
///
/// `07-dictation.md §1.5`: the endpoint separates two instruments deliberately, and the split
/// matters. `prompt` is *"unstructured context about the recording"* — the situation, in a
/// sentence. `keywords` is *"literal terms you expect to hear"*, and it is the whole reason
/// `gpt-transcribe` is used rather than the cheaper mini model, which does not take it.
///
/// Why this is the load-bearing parameter in the feature: both of this app's inputs are worst
/// cases in the recognition literature at once — children's speech (Kid-Whisper measures 3–10×
/// the word error rate of adult read speech) and mathematical language (MathSpeech's own
/// abstract contains "i side of x" for "i sine of x"). Without steering, a maths tutor hears
/// "sign" for "sine", "co-sign" for "cosine", "x squad" for "x squared" and "radicle" for
/// "radical" — every one of those is the commoner English word.
///
/// Kept as named constants rather than buried in a request builder because the list is meant to
/// be read, argued with and pruned: the guide is explicit that *"keywords are hints, not
/// required output"* and that only relevant terms should be included.
enum DictationVocabulary {
    /// The situation, and nothing else. Short on purpose: `prompt` is prepended to the model's
    /// context on every request, and a long one starts shaping the *wording* of the transcript
    /// rather than its spelling.
    static let prompt = """
        A student is thinking out loud about a maths problem for a tutor. \
        Numbers and operations are spoken in words, not symbols.
        """

    /// The terms themselves. One per entry, never a phrase list in a single string: the
    /// endpoint rejects the whole request over a stray newline (see `sanitised(_:)`).
    static let keywords = [
        "sine", "cosine", "tangent", "theta", "pi", "squared", "cubed", "square root",
        "radical", "radicand", "exponent", "power", "numerator", "denominator",
        "fraction", "decimal", "percent", "ratio", "equation", "inequality",
        "expression", "coefficient", "variable", "constant", "integer", "factor",
        "factorise", "simplify", "substitute", "expand", "solve for x", "quotient",
        "remainder", "absolute value", "logarithm", "polynomial", "quadratic",
        "binomial", "vertex", "slope", "intercept", "axis", "origin", "coordinate",
        "vector", "angle", "degrees", "radians", "hypotenuse", "isosceles",
        "perpendicular", "parallel", "congruent", "perimeter", "circumference",
        "diameter", "radius", "area", "volume", "plus", "minus", "times", "divided by",
        "equals", "negative", "over", "therefore"
    ]

    /// Stated rather than detected. A mispredicted language on a four-word utterance is a total
    /// loss, and the docs note that an unreliable prediction comes back as `"languages": []`.
    static let languages = ["en"]

    /// The endpoint's own rejection rule, applied before the request is built rather than
    /// discovered as a 400: *"Keep each keyword on one line and don't include `<`, `>`, a
    /// carriage return, or a line feed. The API rejects the entire request when it encounters
    /// one of these characters."*
    ///
    /// A whole-request rejection is the important part — a bad character does not drop the
    /// parameter, it loses the student's recording. So this is a guard on a constant that a
    /// future edit could break, not defence against user input: nothing here comes from the
    /// student.
    static func sanitised(_ value: String) -> String {
        // A space rather than nothing, so removing a character cannot glue two words into one
        // the model has never seen. Whitespace is then collapsed, which also handles a CRLF
        // arriving as two separators.
        value
            .replacingOccurrences(of: "<", with: " ")
            .replacingOccurrences(of: ">", with: " ")
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// The keywords as they go on the wire: sanitised, emptied entries dropped.
    static var wireKeywords: [String] {
        keywords.map(sanitised).filter { !$0.isEmpty }
    }
}

// MARK: - The request

/// Builds the transcription request without touching the network, so tests can inspect the
/// exact multipart contract the endpoint documents. The same value-only shape
/// `OpenAIResponsesRequestBuilder` uses for the tutor.
enum OpenAITranscriptionRequestBuilder {
    static let endpoint = "https://api.openai.com/v1/audio/transcriptions"
    /// `07-dictation.md §1.4`. Not `gpt-4o-mini-transcribe`: the mini model cannot take
    /// `keywords`, and at a fifth of a cent per question the saving does not buy back
    /// "solve for eggs".
    static let model = "gpt-transcribe"
    /// The endpoint infers the container from the filename *and* the part's content type, so
    /// both have to agree with what `WAVFile` actually wrote.
    static let filename = "speech.wav"
    static let contentType = "audio/wav"

    static func multipartBody(audio: Data, boundary: String) -> Data {
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            body.append("\(value)\r\n")
        }

        field("model", model)
        // Partial text flows into the composer while the recording is being transcribed.
        // Without this the student watches a blinking mark for the whole of it.
        field("stream", "true")
        field("prompt", DictationVocabulary.sanitised(DictationVocabulary.prompt))
        // Array parameters repeat the field rather than joining values, because a joined list
        // would need a separator and every plausible separator is either a character the
        // endpoint rejects or a character that appears inside a keyword.
        for keyword in DictationVocabulary.wireKeywords { field("keywords", keyword) }
        for language in DictationVocabulary.languages { field("languages", language) }

        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n")
        body.append("Content-Type: \(contentType)\r\n\r\n")
        body.append(audio)
        body.append("\r\n--\(boundary)--\r\n")
        return body
    }

    /// `boundary` is a parameter rather than a private detail so a test can assert the body
    /// byte for byte. Callers take the default, which is a fresh one per request.
    static func urlRequest(audio: Data, apiKey: String, boundary: String = UUID().uuidString) -> URLRequest? {
        guard let url = URL(string: endpoint) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = multipartBody(audio: audio, boundary: boundary)
        return request
    }
}

// MARK: - The response

/// The streamed transcription, read one server-sent-event line at a time.
///
/// A value type with no network in it, because every interesting case — deltas that arrive in
/// pieces, a frame that does not parse, a stream that stops before it finishes — is a string
/// problem and should be testable as one.
///
/// **The deltas are appends, not revisions.** This is the one behavioural difference from
/// `SFSpeechRecognizer`, whose partials each restated the whole utterance; code that replaces
/// the field on every event would show only the last fragment. This adds them up, so what
/// leaves here is the running transcript `DictationTranscript` promises.
struct OpenAITranscriptionReader {
    private(set) var text = ""
    private(set) var isComplete = false

    /// The reading this line produced, or `nil` for a line that carried none: the blank
    /// separators between frames, SSE comments, `event:` fields, the closing `[DONE]`, and any
    /// frame whose JSON does not parse. An unreadable frame is skipped rather than thrown on,
    /// because the stream ending without its own completion event is already the failure and
    /// there is no second way to say it.
    mutating func read(_ line: String) -> DictationTranscript? {
        guard !isComplete, let payload = Self.payload(of: line) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
              let type = object["type"] as? String else { return nil }

        switch type {
        case "transcript.text.delta":
            guard let delta = object["delta"] as? String, !delta.isEmpty else { return nil }
            text += delta
            return DictationTranscript(text: text, isFinal: false, phase: .transcribing)
        case "transcript.text.done":
            // The completion event is authoritative, not merely terminal: it carries the whole
            // transcript, punctuated and cased, where the sum of the deltas need not be.
            if let final = object["text"] as? String, !final.isEmpty { text = final }
            isComplete = true
            return DictationTranscript(text: text, isFinal: true, phase: .transcribing)
        default:
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

// MARK: - What "nothing was said" actually looks like

/// Whether a finished transcript is really nothing.
///
/// `07-dictation.md §1.6/§2.9`: `isEmpty` is not a sufficient guard. Whisper-family models
/// hallucinate on near-silent audio — "Careless Whisper" (FaCCT '24) measured *"roughly 1% of
/// audio transcriptions contained entire hallucinated phrases"* and found they
/// *"disproportionately occur for individuals who speak with longer shares of non-vocal
/// durations"*, which is exactly a child who taps the mic, hesitates, and taps again. The
/// documented output in that case is caption boilerplate: `" you"`, `"Thank you."`, "subtitles
/// by …".
///
/// So a short result that is nothing but boilerplate is treated as silence and never written
/// into the composer. Everything longer is the student's, and the composer-review step — the
/// text lands in an editable field and is never auto-sent — is what catches the rest.
enum DictationSilence {
    /// Only applied under this length, which is long enough for the longest documented
    /// artefact ("Subtitles by the Amara.org community") and far short of a question. A
    /// fabrication longer than this is not something a phrase list can catch, and quietly
    /// deleting a real sentence would be far worse than showing one the student can edit.
    static let boilerplateLimit = 60

    /// Lowercased, stripped of punctuation and collapsed whitespace — the documented
    /// hallucinations vary in casing and trailing stops.
    /// Compared against `normalised(_:)` output, so every entry here is already lowercase and
    /// free of punctuation — "Thanks for watching!" is matched by "thanks for watching".
    static let boilerplate: Set<String> = [
        "", "you", "thank you", "thanks", "thank you very much", "thanks for watching",
        "please subscribe", "subscribe", "bye", "bye bye",
        "subtitles by the amara org community", "subtitles by amara org", "amara org",
        "transcription by castingwords", "the end", "music", "applause", "laughter"
    ]

    static func isSilence(_ transcript: String) -> Bool {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count <= boilerplateLimit else { return false }
        return boilerplate.contains(normalised(trimmed))
    }

    static func normalised(_ transcript: String) -> String {
        let stripped = transcript.lowercased().unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) ? Character(scalar) : " "
        }
        return String(stripped).split(separator: " ").joined(separator: " ")
    }
}

// MARK: - The upload

/// The half of a dictation session that has no microphone in it: audio in, readings out.
///
/// Separated from the capture half deliberately — this is the half a machine with no
/// microphone can still test end to end, and the simulator is such a machine.
struct OpenAITranscriptionClient: Sendable {
    /// Two silent retries before the student is told anything, for the failures that are worth
    /// retrying at all. `07-dictation.md §1.6`.
    static let retryLimit = 2
    /// What to wait when the response carries no `Retry-After`.
    static let fallbackRetryDelay: TimeInterval = 1

    let apiKey: String
    let session: URLSession

    init(apiKey: String, session: URLSession = .shared) {
        self.apiKey = apiKey
        self.session = session
    }

    func readings(for audio: Data) -> AsyncThrowingStream<DictationTranscript, any Error> {
        let (stream, continuation) = AsyncThrowingStream<DictationTranscript, any Error>.makeStream()
        let work = Task {
            do {
                try await run(audio: audio, into: continuation)
                continuation.finish()
            } catch let error as DictationError {
                continuation.finish(throwing: error)
            } catch {
                // Never the provider's or the network's own description: it can quote what was
                // heard, and this is a child speaking.
                continuation.finish(throwing: DictationError.recognitionFailed)
            }
        }
        continuation.onTermination = { _ in work.cancel() }
        return stream
    }

    /// One attempt, plus up to `retryLimit` more for the failures a wait can fix.
    ///
    /// Retries happen before the first delta or not at all: once text has reached the composer,
    /// starting the transcript over would rewrite words the student is already reading.
    private func run(
        audio: Data,
        into continuation: AsyncThrowingStream<DictationTranscript, any Error>.Continuation
    ) async throws {
        for attempt in 0 ... Self.retryLimit {
            do {
                try await attemptTranscription(audio: audio, into: continuation)
                return
            } catch let error as RetryableFailure {
                guard attempt < Self.retryLimit else { throw error.reason }
                try await Task.sleep(for: .seconds(error.delay ?? Self.fallbackRetryDelay))
            }
        }
    }

    private func attemptTranscription(
        audio: Data,
        into continuation: AsyncThrowingStream<DictationTranscript, any Error>.Continuation
    ) async throws {
        guard let request = OpenAITranscriptionRequestBuilder.urlRequest(audio: audio, apiKey: apiKey) else {
            throw DictationError.unavailable
        }

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw DictationError.recognitionFailed }
        guard (200 ..< 300).contains(http.statusCode) else {
            throw await failure(for: http, bytes: bytes)
        }

        var reader = OpenAITranscriptionReader()
        for try await line in bytes.lines {
            guard let reading = reader.read(line) else { continue }
            continuation.yield(reading)
            if reading.isFinal { return }
        }
        // The connection ended before the provider said the transcript was done, so what we
        // have is a fragment of a sentence. Failing is what stops the composer waiting for a
        // rest of it that is never coming, and stops a student being handed half a sentence
        // they may not notice. The words already delivered stay in the field to be edited.
        throw DictationError.recognitionFailed
    }

    /// What a non-2xx response means, and whether waiting could change it.
    ///
    /// The body is read for exactly one thing — the machine-readable `error.code`, which is how
    /// a billing 429 is told from a rate-limit 429 — and the provider's `message` is never kept
    /// or forwarded. Retrying a spend-limit error is pure latency in front of a failure that
    /// will not change.
    private func failure(for response: HTTPURLResponse, bytes: URLSession.AsyncBytes) async -> any Error {
        let reason = Self.failure(status: response.statusCode)
        guard Self.isRetryable(status: response.statusCode) else { return reason }

        let code = await Self.errorCode(from: bytes)
        if let code, Self.terminalBillingCodes.contains(code) { return reason }

        return RetryableFailure(reason: reason, delay: Self.retryDelay(from: response))
    }

    /// A failure worth another attempt, carried separately so the retry loop cannot mistake it
    /// for something to show the student.
    private struct RetryableFailure: Error {
        let reason: DictationError
        let delay: TimeInterval?
    }

    /// An HTTP status, as one of the three failures the product knows how to say.
    ///
    /// 401 and 403 are the credential: nothing about this session will work until it is
    /// changed, which is the same answer as having no key at all. Everything else — 429, 5xx,
    /// a gateway in a bad mood — is this minute's problem and worth another tap.
    static func failure(status: Int) -> DictationError {
        (401 ... 403).contains(status) ? .unavailable : .recognitionFailed
    }

    /// *"Pace your requests and follow the `Retry-After` header when it's present."* 503 is the
    /// overloaded case and 500 is a server fault the docs say to retry after a brief wait.
    static func isRetryable(status: Int) -> Bool {
        status == 429 || status == 500 || status == 503
    }

    /// Waiting cannot buy credit.
    static let terminalBillingCodes: Set<String> = [
        "credit_balance_exhausted",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
        "organization_usage_limit_exceeded"
    ]

    static func retryDelay(from response: HTTPURLResponse) -> TimeInterval? {
        guard let header = response.value(forHTTPHeaderField: "Retry-After"),
              let seconds = TimeInterval(header.trimmingCharacters(in: .whitespaces)),
              seconds > 0 else { return nil }
        // A provider asking for longer than the student will wait is a failure, not a pause.
        return min(seconds, 10)
    }

    /// `error.code` and nothing else. The message is never read into a `String` that could be
    /// logged or shown.
    static func errorCode(from bytes: URLSession.AsyncBytes) async -> String? {
        var body = Data()
        do {
            // Bounded: an error body is small, and this must not become a way to buffer a
            // provider's essay into memory.
            for try await byte in bytes {
                body.append(byte)
                if body.count > 8_192 { break }
            }
        } catch {
            // A body that could not be read through is still worth parsing as far as it got;
            // failing to find a code just means the failure is treated as retryable.
        }
        return errorCode(fromBody: body)
    }

    static func errorCode(fromBody body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let error = object["error"] as? [String: Any],
              let code = error["code"] as? String else { return nil }
        return code
    }
}

// MARK: - The container

/// A RIFF/WAVE wrapper for 16-bit little-endian PCM.
///
/// The endpoint takes `mp3, mp4, mpeg, mpga, m4a, wav, webm`, and WAV is the only one of those
/// that is a header in front of the samples rather than an encoder: at 16 kHz mono the file is
/// small enough that compressing it would cost CPU time before the upload starts and not repay
/// it. 16 kHz is also the band speech models are trained on — nothing above 8 kHz carries
/// phonetic information — so sending more would be uploading detail the transcriber discards.
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
