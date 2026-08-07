import Foundation

/// The backend this app talks to instead of OpenAI directly: a fixed address
/// and the bearer token the device presents on every request (see
/// `server/app/auth.py`, `require_device_token`).
///
/// **Neither half is a setting, and neither is injected at launch.** The
/// address is the constant below. The token is compiled in from a build
/// setting — see `MathTutor/Config/Backend.xcconfig` — because a build the
/// user *taps* has no launching process to take a credential from. Launch
/// injection worked from Xcode, `devicectl` and `run-sim.sh` and nowhere else,
/// which meant a Release build installed on an iPad could never reach the
/// backend at all.
///
/// So there is no field for either, nothing in `UserDefaults`, nothing in the
/// Keychain, and no user-visible surface anywhere that names a server.
///
/// `init?` exists because the token can still be *absent* — a checkout with no
/// `Backend.local.xcconfig` compiles an empty one. That is not "partially
/// configured", it is unusable, since every request would 401 immediately, so
/// it collapses to `nil` and every caller gets one clean signal for "live
/// tutoring is available".
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
    ///
    /// It lives here rather than beside the token in the xcconfig because an
    /// xcconfig value runs to end of line and `//` starts a comment anywhere
    /// on it — `https://host` would be stored as `https:`.
    static let permanentBaseURL = URL(string: "https://air.tail27c2bc.ts.net:8443")!

    /// The `Info.plist` key the build setting lands under.
    static let tokenInfoKey = "MathTutorBackendToken"

    /// The compiled-in token, or `nil` when this build has none.
    ///
    /// `Bundle.main` rather than a stored property: it is read once per request
    /// through `load()`, which costs nothing measurable and keeps the value out
    /// of a global that a test would then have to reset.
    static var bundledToken: String? {
        let raw = Bundle.main.object(forInfoDictionaryKey: tokenInfoKey) as? String
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty ?? true) ? nil : trimmed
    }

    /// Pairs the compiled-in token with the permanent address, or returns
    /// `nil` when this build has no token to present.
    static func load() -> BackendConfiguration? {
        // A UI test must never reach the real backend on the developer's own
        // credential. `--ui-test-reset` is the argument that already means
        // "start from nothing", and with the token compiled in there is no
        // longer a Keychain entry to clear to get there — so it is honoured
        // here instead. Compiled into release builds on purpose: the argument
        // is harmless in a shipped app (nobody passes it) and gating it on
        // DEBUG would leave the UI-test target able to bill a real account.
        guard !ProcessInfo.processInfo.arguments.contains("--ui-test-reset") else { return nil }
        return BackendConfiguration(baseURL: resolvedBaseURL, token: bundledToken ?? "")
    }

    /// `permanentBaseURL`, unless a DEBUG launch points this build at a local
    /// server instead. Unlike the token this is genuinely a *dev-loop* value —
    /// nothing persists it, unset the variable and the build is back on the
    /// shipped address — and it is compiled out of release builds entirely.
    private static var resolvedBaseURL: URL {
        #if DEBUG
        let override = ProcessInfo.processInfo.environment["MATHTUTOR_BACKEND_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let override, !override.isEmpty, let url = URL(string: override) {
            return url
        }
        #endif
        return permanentBaseURL
    }
}
