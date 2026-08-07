import Foundation
import XCTest
@testable import MathTutor

/// The device's side of the backend contract, now that the app has no credential surface at
/// all: the Keychain accessors renamed off the OpenAI-key era, the migration that clears
/// whatever a real key left behind, the permanent address that replaced the stored one, and
/// the DEBUG-only dev-loop injection.
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

    // MARK: - The address is a constant, not a setting

    /// The whole reason this app has no server field: there is one address, it is in the
    /// binary, and it is reachable without anything having been configured on the device.
    func testThePermanentAddressIsAWholeHTTPSURL() {
        let url = BackendConfiguration.permanentBaseURL
        XCTAssertEqual(url.scheme, "https", "the device must never be pointed at cleartext")
        XCTAssertNotNil(url.host)
    }

    /// Nothing about the address is persisted, so nothing about it can be left behind by a
    /// previous launch or reached by anything that can write `UserDefaults`. This asserts the
    /// absence directly: the key the migration-era build stored it under is not read by
    /// anything any more, so a value sitting there must have no effect.
    func testAStaleStoredAddressCannotOverrideThePermanentOne() throws {
        let suiteName = "SettingsBackendTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("https://leftover.example.com", forKey: "mathTutor.backendBaseURL")

        let keychain = KeychainStore()
        keychain.saveBackendToken("device-token")
        defer { keychain.removeBackendToken() }

        let configuration = try XCTUnwrap(BackendConfiguration.load(keychain: keychain))
        XCTAssertNotEqual(configuration.baseURL.host, "leftover.example.com")
    }

    // MARK: - The token is the only half that can be missing

    /// `BackendConfiguration.init?`: an empty token is unusable, and treated exactly like no
    /// configuration at all rather than as a half-configured state anyone has to check for.
    func testAnEmptyTokenIsTreatedAsNoConfigurationAtAll() {
        XCTAssertNil(BackendConfiguration(baseURL: nil, token: "t"))
        XCTAssertNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: ""))
        XCTAssertNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: "   "))
        XCTAssertNotNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: "t"))
    }

    /// `load` pairs the Keychain's token with the permanent address, and returns nothing at
    /// all when there is no token to pair.
    func testLoadPairsTheStoredTokenWithThePermanentAddress() throws {
        let keychain = KeychainStore()
        keychain.saveBackendToken("device-token")
        defer { keychain.removeBackendToken() }

        let configuration = try XCTUnwrap(BackendConfiguration.load(keychain: keychain))
        XCTAssertEqual(configuration.token, "device-token")
        #if DEBUG
        // A dev-loop launch may be pointing this process at a local server; the permanent
        // address is only the expected answer when nothing is overriding it.
        if DebugBackendInjection.overriddenBaseURL() == nil {
            XCTAssertEqual(configuration.baseURL, BackendConfiguration.permanentBaseURL)
        }
        #else
        XCTAssertEqual(configuration.baseURL, BackendConfiguration.permanentBaseURL)
        #endif
    }

    func testLoadReturnsNothingWithoutAToken() {
        let keychain = KeychainStore()
        keychain.removeBackendToken()
        defer { keychain.removeBackendToken() }

        XCTAssertNil(BackendConfiguration.load(keychain: keychain))
    }

    /// `usesLiveTutor` is read once at launch from the Keychain, because there is no longer
    /// anything in the app that can change it mid-session — the pane that used to save and
    /// remove a token is gone.
    @MainActor
    func testUsesLiveTutorFollowsTheStoredTokenAtLaunch() {
        let keychain = KeychainStore()
        keychain.saveBackendToken("device-token")
        defer { keychain.removeBackendToken() }

        let store = TutorStore(service: DemoTutorService(), persistence: .inMemory, keychain: keychain)
        XCTAssertTrue(store.usesLiveTutor)
    }

    #if DEBUG
    // MARK: - The dev-loop injection shim

    /// The two halves are read independently now: a token seeds the Keychain, an address
    /// overrides the permanent one, and neither requires the other.
    func testInjectedTokenIsReadWithoutAnAddress() {
        XCTAssertNil(DebugBackendInjection.injectedToken(environment: [:]))
        XCTAssertEqual(
            DebugBackendInjection.injectedToken(environment: [
                DebugBackendInjection.tokenEnvironmentKey: "device-token",
            ]),
            "device-token"
        )
    }

    func testOverriddenBaseURLIsReadWithoutAToken() {
        XCTAssertNil(DebugBackendInjection.overriddenBaseURL(environment: [:]))
        XCTAssertEqual(
            DebugBackendInjection.overriddenBaseURL(environment: [
                DebugBackendInjection.baseURLEnvironmentKey: "http://localhost:8080",
            ]),
            URL(string: "http://localhost:8080")
        )
    }

    /// The token also accepts a file path — the fallback for a credential too long or too
    /// sensitive to want in a shell's environment directly.
    func testInjectedTokenIsReadFromAFileWhenTheDirectValueIsAbsent() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("DebugBackendInjectionTests-\(UUID().uuidString).txt")
        try "device-token-from-file\n".write(to: fileURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        XCTAssertEqual(
            DebugBackendInjection.injectedToken(environment: [
                DebugBackendInjection.tokenEnvironmentFileKey: fileURL.path,
            ]),
            "device-token-from-file",
            "trailing whitespace must be trimmed"
        )
    }

    func testInjectionTreatsWhitespaceOnlyValuesAsAbsent() {
        XCTAssertNil(DebugBackendInjection.injectedToken(environment: [
            DebugBackendInjection.tokenEnvironmentKey: "   ",
        ]))
        XCTAssertNil(DebugBackendInjection.overriddenBaseURL(environment: [
            DebugBackendInjection.baseURLEnvironmentKey: "   ",
        ]))
    }
    #endif
}
