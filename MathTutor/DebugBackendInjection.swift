import Foundation

#if DEBUG
/// Development-only backend configuration injection for local simulator/device runs.
///
/// Reads a backend base URL and device token from the launch environment so a
/// build-run-test loop never has to retype them into Settings. `TutorStore` seeds
/// the token into the Keychain and the base URL into `UserDefaults` once at
/// launch, so later launches without the environment set stay live.
///
/// Neither value is read from source, the Xcode project, or checked-in files: they
/// arrive from the launching process (see `scripts/run-sim.sh`, which reads a
/// gitignored `.env.local`). This whole type is compiled out of release builds, and
/// `TutorStore` deliberately skips it for `--ui-test-reset` launches so UI tests
/// never inherit a developer credential.
enum DebugBackendInjection {
    /// The backend's base URL, e.g. `MATHTUTOR_BACKEND_URL=http://localhost:8080`.
    static let baseURLEnvironmentKey = "MATHTUTOR_BACKEND_URL"
    /// The device bearer token, direct value form.
    static let tokenEnvironmentKey = "MATHTUTOR_BACKEND_TOKEN"
    /// Path to a file whose entire contents are the token. Tilde paths are expanded.
    static let tokenEnvironmentFileKey = "MATHTUTOR_BACKEND_TOKEN_FILE"

    struct Injected {
        let baseURL: URL
        let token: String
    }

    /// The injected configuration, or `nil` unless a valid base URL *and* a
    /// non-empty token are both present — the same "both halves or neither"
    /// rule `BackendConfiguration.init?` applies everywhere else.
    static func injectedConfiguration(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Injected? {
        guard let urlString = normalized(environment[baseURLEnvironmentKey]),
              let baseURL = URL(string: urlString) else { return nil }
        guard let token = injectedToken(environment: environment) else { return nil }
        return Injected(baseURL: baseURL, token: token)
    }

    private static func injectedToken(environment: [String: String]) -> String? {
        if let direct = normalized(environment[tokenEnvironmentKey]) {
            return direct
        }
        guard let rawPath = normalized(environment[tokenEnvironmentFileKey]) else {
            return nil
        }
        let expanded = (rawPath as NSString).expandingTildeInPath
        guard let contents = try? String(contentsOfFile: expanded, encoding: .utf8) else {
            return nil
        }
        return normalized(contents)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
#endif
