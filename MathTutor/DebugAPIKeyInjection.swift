import Foundation

#if DEBUG
/// Development-only credential injection for local simulator/device runs.
///
/// Reads an OpenAI key from the launch environment so a build-run-test loop never
/// has to retype it into Settings. `TutorStore` seeds the value into the Keychain
/// once at launch, so later launches without the environment set stay live.
///
/// The key is never read from source, the Xcode project, or UserDefaults: the
/// value arrives from the launching process (see `scripts/run-sim.sh`, which reads
/// a gitignored `.env.local`). This whole type is compiled out of release builds,
/// and `TutorStore` deliberately skips it for `--ui-test-reset` launches so UI
/// tests never inherit a developer credential.
enum DebugAPIKeyInjection {
    /// Direct value, e.g. `SIMCTL_CHILD_MATHTUTOR_OPENAI_API_KEY=sk-…`.
    static let environmentKey = "MATHTUTOR_OPENAI_API_KEY"
    /// Path to a file whose entire contents are the key. Tilde paths are expanded.
    static let environmentFileKey = "MATHTUTOR_OPENAI_API_KEY_FILE"

    /// The injected key, or `nil` when neither variable yields a non-empty value.
    static func injectedKey(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        if let direct = environment[environmentKey], let value = normalized(direct) {
            return value
        }
        guard let rawPath = environment[environmentFileKey], let path = normalized(rawPath) else {
            return nil
        }
        let expanded = (path as NSString).expandingTildeInPath
        guard let contents = try? String(contentsOfFile: expanded, encoding: .utf8) else {
            return nil
        }
        return normalized(contents)
    }

    private static func normalized(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
#endif
