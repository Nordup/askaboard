import Foundation

/// The backend this app talks to instead of OpenAI directly: a fixed address
/// and the bearer token the device presents on every request (see
/// `server/app/auth.py`, `require_device_token`).
///
/// **The address is not a setting.** The app is pointed at one service, and
/// which host that is belongs to whoever deploys it — not to the student, and
/// not to anything the client can be talked into changing. So there is no
/// field for it, nothing about it in `UserDefaults`, and no user-visible
/// surface anywhere that names a server. `permanentBaseURL` is the whole of
/// it.
///
/// `token` is still optional in practice, which is why `init?` exists: a
/// configuration with no token is not "partially configured" — it is
/// unusable, since every request would 401 immediately. Treating that as
/// `nil` means every caller gets one clean signal for "live tutoring is
/// available" rather than checking the token itself.
struct BackendConfiguration: Sendable, Equatable {
    var baseURL: URL
    var token: String

    /// - Parameters:
    ///   - baseURL: The backend's base URL. `nil` fails initialization.
    ///   - token: The device bearer token. Whitespace-only counts as empty;
    ///     an empty token fails initialization the same as a missing one.
    init?(baseURL: URL?, token: String) {
        guard let baseURL else { return nil }
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        self.baseURL = baseURL
        self.token = token
    }

    /// The one address this app ships pointed at.
    ///
    /// Force-unwrapped deliberately: it is a literal in this file, so a `nil`
    /// here is a typo caught the first time anyone launches the app, not a
    /// runtime condition worth a fallback path.
    static let permanentBaseURL = URL(string: "https://air.tail27c2bc.ts.net:8443")!

    /// Reads the token from the Keychain and pairs it with the permanent
    /// address, returning `nil` when there is no usable token.
    static func load(keychain: KeychainStore = KeychainStore()) -> BackendConfiguration? {
        BackendConfiguration(baseURL: resolvedBaseURL, token: keychain.readBackendToken() ?? "")
    }

    /// `permanentBaseURL`, unless a DEBUG launch points this build at a local
    /// server instead. That override arrives from the launching process and
    /// exists only for the build-run-test loop — it is a developer's, not a
    /// setting, and it is compiled out of release builds entirely.
    private static var resolvedBaseURL: URL {
        #if DEBUG
        DebugBackendInjection.overriddenBaseURL() ?? permanentBaseURL
        #else
        permanentBaseURL
        #endif
    }
}
