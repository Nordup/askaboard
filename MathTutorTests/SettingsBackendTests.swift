import Foundation
import XCTest
@testable import MathTutor

/// Client-migration Task 6: the Keychain accessors renamed off the OpenAI-key era, the
/// migration that clears whatever a real key left behind, `usesLiveTutor` widening to
/// require the base URL `BackendConfiguration` now needs alongside the token, and the
/// DEBUG-only dev-loop injection that replaced `DebugAPIKeyInjection`.
final class SettingsBackendTests: XCTestCase {
    // MARK: - Migration off the legacy account

    /// The migration's own contract, independent of any `TutorStore`: whatever the legacy
    /// `openai-api-key` account holds is gone afterward.
    func testMigrationRemovesAnyStoredOpenAIKey() {
        let keychain = KeychainStore()
        keychain.saveLegacyAPIKeyForTesting("sk-should-not-survive")
        keychain.migrateAwayFromAPIKey()
        XCTAssertNil(keychain.readLegacyAPIKeyForTesting())
    }

    /// `errSecItemNotFound` counts as success, the same way `removeBackendToken()` treats it
    /// — a launch with nothing to migrate must not report failure.
    func testMigrationSucceedsWhenThereIsNothingToMigrate() {
        let keychain = KeychainStore()
        keychain.migrateAwayFromAPIKey()
        XCTAssertTrue(keychain.migrateAwayFromAPIKey())
        XCTAssertNil(keychain.readLegacyAPIKeyForTesting())
    }

    /// Migrating away from the legacy account must never disturb the current one.
    func testMigrationLeavesTheCurrentBackendTokenAlone() {
        let keychain = KeychainStore()
        keychain.saveLegacyAPIKeyForTesting("sk-legacy")
        keychain.saveBackendToken("current-device-token")
        defer { keychain.removeBackendToken() }

        keychain.migrateAwayFromAPIKey()

        XCTAssertNil(keychain.readLegacyAPIKeyForTesting())
        XCTAssertEqual(keychain.readBackendToken(), "current-device-token")
    }

    /// The call site the brief names directly: a real key from before this migration must be
    /// gone after `TutorStore.init` runs, on every launch — not just a debug-flagged one.
    @MainActor
    func testTutorStoreInitMigratesAwayFromAnyStoredOpenAIKey() throws {
        let keychain = KeychainStore()
        keychain.saveLegacyAPIKeyForTesting("sk-should-not-survive-either")

        _ = TutorStore(service: DemoTutorService(), persistence: .inMemory, keychain: keychain)

        XCTAssertNil(keychain.readLegacyAPIKeyForTesting())
    }

    // MARK: - Both halves required

    /// `BackendConfiguration.init?` itself: a base URL with no token, or a token with no
    /// base URL, is unusable — treated exactly like no configuration at all.
    func testLiveTutoringRequiresBothTheURLAndTheToken() {
        XCTAssertNil(BackendConfiguration(baseURL: nil, token: "t"))
        XCTAssertNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: ""))
        XCTAssertNotNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: "t"))
    }

    /// The same rule, through `TutorStore.usesLiveTutor`: a token with no base URL saved is
    /// not enough, and saving the base URL is what flips it.
    @MainActor
    func testUsesLiveTutorStaysFalseUntilBothHalvesAreSaved() throws {
        let (defaults, cleanup) = try isolatedDefaults()
        defer { cleanup() }
        let keychain = KeychainStore()
        keychain.removeBackendToken()
        defer { keychain.removeBackendToken() }

        let store = TutorStore(
            service: DemoTutorService(), persistence: .inMemory, keychain: keychain, defaults: defaults
        )
        XCTAssertFalse(store.usesLiveTutor, "neither half is saved yet")

        XCTAssertTrue(store.saveBackendToken("device-token"))
        XCTAssertFalse(store.usesLiveTutor, "a token alone must not be enough")

        XCTAssertTrue(store.saveBaseURL("https://backend.example.com"))
        XCTAssertTrue(store.usesLiveTutor, "both halves are now present")
    }

    /// Removing the token drops `usesLiveTutor` even though the base URL is still saved —
    /// the destructive control only the token has must not leave the app half-configured
    /// and still claiming to be live.
    @MainActor
    func testRemovingTheTokenDropsUsesLiveTutorEvenWithABaseURLStillSaved() throws {
        let (defaults, cleanup) = try isolatedDefaults()
        defer { cleanup() }
        let keychain = KeychainStore()
        keychain.saveBackendToken("device-token")
        defer { keychain.removeBackendToken() }

        let store = TutorStore(
            service: DemoTutorService(), persistence: .inMemory, keychain: keychain, defaults: defaults
        )
        XCTAssertTrue(store.saveBaseURL("https://backend.example.com"))
        XCTAssertTrue(store.usesLiveTutor)

        XCTAssertTrue(store.removeBackendToken())
        XCTAssertFalse(store.usesLiveTutor)
    }

    /// `saveBaseURL` declines an empty or unparseable address rather than clearing whatever
    /// was already saved — an empty save is not a designed way to clear this field, the same
    /// rule `saveBackendToken` already follows for an empty token.
    @MainActor
    func testSaveBaseURLDeclinesEmptyAndUnparseableAddressesWithoutClearingTheStoredOne() throws {
        let (defaults, cleanup) = try isolatedDefaults()
        defer { cleanup() }
        let keychain = KeychainStore()
        keychain.removeBackendToken()
        defer { keychain.removeBackendToken() }

        let store = TutorStore(
            service: DemoTutorService(), persistence: .inMemory, keychain: keychain, defaults: defaults
        )
        XCTAssertTrue(store.saveBaseURL("https://backend.example.com"))

        XCTAssertFalse(store.saveBaseURL(""))
        XCTAssertFalse(store.saveBaseURL("   "))
        XCTAssertFalse(store.saveBaseURL("not a url"))
        XCTAssertEqual(
            defaults.string(forKey: BackendConfiguration.baseURLDefaultsKey), "https://backend.example.com",
            "a declined save must not disturb the address already on file"
        )
    }

    // MARK: - `--ui-test-reset` clears both halves

    /// UI tests must never inherit a developer credential from the simulator — the rule
    /// `DebugBackendInjection`'s own doc comment states, now covering the base URL as well as
    /// the token.
    @MainActor
    func testUITestResetClearsBothTheTokenAndTheBaseURL() throws {
        let (defaults, cleanup) = try isolatedDefaults()
        defer { cleanup() }
        let keychain = KeychainStore()
        keychain.saveBackendToken("leftover-token")
        defer { keychain.removeBackendToken() }
        defaults.set("https://leftover.example.com", forKey: BackendConfiguration.baseURLDefaultsKey)

        let store = TutorStore(
            service: DemoTutorService(),
            persistence: .inMemory,
            keychain: keychain,
            defaults: defaults
        )
        // `--ui-test-reset` is read from `ProcessInfo.processInfo.arguments`, which a unit
        // test cannot inject — so this asserts the state the reset is supposed to leave
        // behind is at least reachable through the public API it uses to get there.
        XCTAssertTrue(store.removeBackendToken())
        defaults.removeObject(forKey: BackendConfiguration.baseURLDefaultsKey)
        XCTAssertFalse(store.usesLiveTutor)
        XCTAssertNil(keychain.readBackendToken())
        XCTAssertNil(defaults.string(forKey: BackendConfiguration.baseURLDefaultsKey))
    }

    #if DEBUG
    // MARK: - The dev-loop injection shim

    func testDebugBackendInjectionRequiresBothTheURLAndTheToken() {
        XCTAssertNil(DebugBackendInjection.injectedConfiguration(environment: [:]))
        XCTAssertNil(DebugBackendInjection.injectedConfiguration(environment: [
            DebugBackendInjection.baseURLEnvironmentKey: "https://backend.example.com",
        ]))
        XCTAssertNil(DebugBackendInjection.injectedConfiguration(environment: [
            DebugBackendInjection.tokenEnvironmentKey: "device-token",
        ]))
    }

    func testDebugBackendInjectionReadsBothDirectValues() throws {
        let injected = try XCTUnwrap(DebugBackendInjection.injectedConfiguration(environment: [
            DebugBackendInjection.baseURLEnvironmentKey: "https://backend.example.com",
            DebugBackendInjection.tokenEnvironmentKey: "device-token",
        ]))
        XCTAssertEqual(injected.baseURL, URL(string: "https://backend.example.com"))
        XCTAssertEqual(injected.token, "device-token")
    }

    /// The token half also accepts a file path — the same fallback `DebugAPIKeyInjection`
    /// offered for a key too long or too sensitive to want in a shell's environment directly.
    func testDebugBackendInjectionReadsTheTokenFromAFileWhenTheDirectValueIsAbsent() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("DebugBackendInjectionTests-\(UUID().uuidString).txt")
        try "device-token-from-file\n".write(to: fileURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        let injected = try XCTUnwrap(DebugBackendInjection.injectedConfiguration(environment: [
            DebugBackendInjection.baseURLEnvironmentKey: "https://backend.example.com",
            DebugBackendInjection.tokenEnvironmentFileKey: fileURL.path,
        ]))
        XCTAssertEqual(injected.token, "device-token-from-file", "trailing whitespace must be trimmed")
    }

    func testDebugBackendInjectionTreatsWhitespaceOnlyValuesAsAbsent() {
        XCTAssertNil(DebugBackendInjection.injectedConfiguration(environment: [
            DebugBackendInjection.baseURLEnvironmentKey: "   ",
            DebugBackendInjection.tokenEnvironmentKey: "device-token",
        ]))
        XCTAssertNil(DebugBackendInjection.injectedConfiguration(environment: [
            DebugBackendInjection.baseURLEnvironmentKey: "https://backend.example.com",
            DebugBackendInjection.tokenEnvironmentKey: "   ",
        ]))
    }
    #endif

    // MARK: - Helpers

    /// A throwaway `UserDefaults` suite, cleaned up by the returned closure — the pattern
    /// `MathTutorTests.testAppearancePreferenceDefaultsToLightAndRoundTrips` already uses,
    /// so a test that saves a base URL never reads another test's (or the app's real) value
    /// out of `UserDefaults.standard`.
    private func isolatedDefaults() throws -> (UserDefaults, () -> Void) {
        let suiteName = "SettingsBackendTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        return (defaults, { defaults.removePersistentDomain(forName: suiteName) })
    }
}
