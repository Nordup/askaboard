import Foundation

/// One uploaded file, as the composer needs it.
struct UploadedAttachment: Sendable {
    let attachment: MessageAttachment
    /// Written to `AttachmentStore` the moment the turn is sent, and not
    /// before: an attachment the learner removes before sending should leave
    /// nothing on disk.
    let thumbnail: Data
}

/// `POST /v1/attachments` — the composer's file, ahead of the turn it belongs to.
///
/// A separate type from `BackendTutorService` because it is a different
/// conversation: one request, one response, no stream, no board rendezvous. It
/// shares only the configuration. Field names throughout mirror
/// `server/app/api/attachments.py` exactly (`UploadResponse`, `session_id` and
/// `file` as the two multipart parts) — do not rename them without re-reading
/// that file first.
///
/// It sends the bytes and nothing else. Every question about what a file *is*
/// — whether it can be read at all, what it converts to, how many pages it has
/// — is answered on the server, which is why this file mentions no format by
/// name.
struct AttachmentUploader: Sendable {
    let configuration: BackendConfiguration
    let session: URLSession

    /// The upload carries the file's whole body over a connection that may be
    /// slow, and the server decodes and re-encodes an image or rasterises a
    /// PDF page before it answers (see `server/app/attachments/convert.py`) —
    /// so this is deliberately longer than a plain request timeout and
    /// deliberately still finite.
    static let timeout: TimeInterval = 90

    init(configuration: BackendConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    func upload(
        _ data: Data, filename: String, contentType: String, sessionID: UUID
    ) async throws -> UploadedAttachment {
        // Minted fresh per call, and never reused across a retry: a boundary
        // derived from a random v4 UUID (122 bits) has no realistic chance of
        // occurring inside the file's own bytes, so no scan of `data` for a
        // collision is needed.
        let boundary = "Boundary-\(UUID().uuidString)"
        let body = Self.multipartBody(
            boundary: boundary, sessionID: sessionID,
            filename: filename, contentType: contentType, data: data
        )
        let request = Self.urlRequest(boundary: boundary, configuration: configuration, body: body)

        let (responseData, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw TutorServiceError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw TutorServiceError.network(Self.refusal(
                statusCode: http.statusCode,
                body: String(decoding: responseData, as: UTF8.self)
            ))
        }

        let decoded: UploadResponse
        do {
            decoded = try JSONDecoder().decode(UploadResponse.self, from: responseData)
        } catch {
            // Every other exit from this method throws a `TutorServiceError`, and a
            // caller catching that type would otherwise miss a schema drift entirely
            // — the learner would get a raw Swift decode error where a sentence
            // belongs.
            throw TutorServiceError.invalidResponse
        }
        // A response we cannot read is a response we cannot read, whichever field
        // it is: corrupt base64 here is the same class of failure as the decode
        // above, not a reason to hand `AttachmentStore` a silent zero-byte file.
        guard let thumbnail = Data(base64Encoded: decoded.thumbnail_base64) else {
            throw TutorServiceError.invalidResponse
        }
        return UploadedAttachment(
            attachment: MessageAttachment(
                id: decoded.id,
                filename: filename,
                kind: decoded.kind,
                pageCount: decoded.page_count
            ),
            thumbnail: thumbnail
        )
    }

    /// The exact response `server/app/api/attachments.py` (`UploadResponse`)
    /// returns. Field names are snake_case on the wire; do not rename them
    /// without re-reading that file.
    private struct UploadResponse: Decodable {
        let id: UUID
        let kind: String
        let page_count: Int
        let thumbnail_base64: String
    }

    static func urlRequest(
        boundary: String, configuration: BackendConfiguration, body: Data
    ) -> URLRequest {
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent("v1/attachments"))
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue(
            "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type"
        )
        request.httpBody = body
        return request
    }

    /// `multipart/form-data`, assembled by hand: two parts, `session_id` as a
    /// plain form field and `file` carrying the filename and content type —
    /// exactly what `upload_attachment` in `server/app/api/attachments.py`
    /// reads with `Form(...)` and `File(...)`.
    ///
    /// Written out rather than reached for, because Foundation has no
    /// multipart encoder and a 20MB attachment is not worth a dependency.
    /// CRLF everywhere: the format requires it, and an LF-only body is
    /// rejected by strict parsers for reasons that are miserable to debug.
    static func multipartBody(
        boundary: String, sessionID: UUID, filename: String, contentType: String, data: Data
    ) -> Data {
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"session_id\"\r\n\r\n")
        append("\(sessionID.uuidString)\r\n")

        // Escaped per RFC 2183's quoted-string rule: a filename containing a
        // `"` or `\` — iOS permits both in a Files-picked name — would
        // otherwise close the quote early or eat the character after it and
        // hand the server a malformed header.
        let escapedFilename = filename
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(escapedFilename)\"\r\n")
        append("Content-Type: \(contentType)\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")

        return body
    }

    /// The server's own sentence, or a fallback when it did not send one.
    ///
    /// The refusals this endpoint returns are written for a chip in the
    /// composer — they name the file and suggest the way out. Rewriting them
    /// here would be writing the same copy twice and getting it wrong once.
    static func refusal(statusCode: Int, body: String) -> String {
        if let data = body.data(using: .utf8),
           let payload = try? JSONDecoder().decode([String: String].self, from: data),
           let detail = payload["detail"] {
            return detail
        }
        return "That file couldn’t be attached (HTTP \(statusCode))."
    }
}
