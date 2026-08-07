import Foundation

/// The backend this app talks to instead of OpenAI directly: a base URL and
/// the bearer token the device presents on every request (see
/// `server/app/auth.py`, `require_device_token`).
///
/// Both halves are required by `init?` on purpose. A base URL with no token,
/// or a token with no base URL, is not "partially configured" — it is
/// unusable, since every request would either have nowhere to go or 401
/// immediately. Treating that as `nil` (rather than optional-optional
/// fields on a plain struct) means every caller gets one clean signal for
/// "live tutoring is available" instead of having to remember to check both
/// fields itself.
struct BackendConfiguration: Sendable, Equatable {
    var baseURL: URL
    var token: String

    /// - Parameters:
    ///   - baseURL: The backend's base URL (e.g. `http://localhost:8080`).
    ///     `nil` fails initialization.
    ///   - token: The device bearer token. Whitespace-only counts as empty;
    ///     an empty token fails initialization the same as a missing one.
    init?(baseURL: URL?, token: String) {
        guard let baseURL else { return nil }
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        self.baseURL = baseURL
        self.token = token
    }

    /// The `UserDefaults` key the base URL is stored under. The token is not
    /// stored here — it lives in the Keychain, never in `UserDefaults`.
    static let baseURLDefaultsKey = "mathTutor.backendBaseURL"

    /// Reads the base URL from `UserDefaults` and the token from the
    /// Keychain, returning `nil` whenever either half is missing or invalid.
    static func load(defaults: UserDefaults = .standard, keychain: KeychainStore = KeychainStore()) -> BackendConfiguration? {
        let baseURL = defaults.string(forKey: baseURLDefaultsKey).flatMap(URL.init(string:))
        return BackendConfiguration(baseURL: baseURL, token: keychain.readBackendToken() ?? "")
    }
}
