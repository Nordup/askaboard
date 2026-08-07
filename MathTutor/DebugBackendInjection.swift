import Foundation

#if DEBUG
/// Development-only backend injection for local simulator/device runs.
///
/// Two separate things, because they are no longer the same kind of thing:
///
/// - the **token** is seeded into the Keychain once at launch, so a
///   build-run-test loop never has to get a credential onto the device by
///   hand and later launches without the environment set stay live;
/// - the **base URL** is a pure override of `BackendConfiguration.permanentBaseURL`,
///   read fresh on every request and never stored. It exists so a developer
///   can point a build at `http://localhost:8080` without editing the
///   permanent address, and nothing persists it — unset the variable and the
///   build is back on the shipped address.
///
/// Neither value is read from source, the Xcode project, or checked-in files:
/// they arrive from the launching process (see `scripts/run-sim.sh`, which
/// reads a gitignored `.env.local`). This whole type is compiled out of
/// release builds, and `TutorStore` deliberately skips the token seed for
/// `--ui-test-reset` launches so UI tests never inherit a developer credential.
enum DebugBackendInjection {
    /// A local backend to use instead of the permanent address, e.g.
    /// `MATHTUTOR_BACKEND_URL=http://localhost:8080`.
    static let baseURLEnvironmentKey = "MATHTUTOR_BACKEND_URL"
    /// The device bearer token, direct value form.
    static let tokenEnvironmentKey = "MATHTUTOR_BACKEND_TOKEN"
    /// Path to a file whose entire contents are the token. Tilde paths are expanded.
    static let tokenEnvironmentFileKey = "MATHTUTOR_BACKEND_TOKEN_FILE"

    /// The address this build should use instead of the permanent one, or
    /// `nil` to leave `BackendConfiguration.permanentBaseURL` alone.
    static func overriddenBaseURL(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL? {
        guard let urlString = normalized(environment[baseURLEnvironmentKey]) else { return nil }
        return URL(string: urlString)
    }

    /// The token to seed into the Keychain, from either the direct variable or
    /// the file one, or `nil` when neither is set.
    static func injectedToken(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
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
