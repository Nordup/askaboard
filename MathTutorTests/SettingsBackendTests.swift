import Foundation
import XCTest
@testable import MathTutor

/// The device's side of the backend contract, now that the app has no credential
/// surface *and* stores nothing: the address is a constant, the token is compiled
/// in from a build setting, and the Keychain's only remaining job is deleting the
/// two credentials older builds used to keep there.
final class SettingsBackendTests: XCTestCase {
    // MARK: - Clearing what older builds stored

    /// Whatever the legacy `openai-api-key` account holds is gone afterward.
    func testMigrationRemovesAnyStoredOpenAIKey() {
        let keychain = KeychainStore()
        keychain.saveLegacyAPIKeyForTesting("sk-should-not-survive")
        keychain.migrateAwayFromStoredCredentials()
        XCTAssertNil(keychain.readLegacyAPIKeyForTesting())
    }

    /// And so is the device token, which is the account this build stopped using
    /// when the token moved into the binary. A device that ran the seeding build
    /// still has one sitting there.
    func testMigrationRemovesAnyStoredDeviceToken() {
        let keychain = KeychainStore()
        keychain.saveLegacyBackendTokenForTesting("seeded-device-token")
        keychain.migrateAwayFromStoredCredentials()
        XCTAssertNil(keychain.readLegacyBackendTokenForTesting())
    }

    /// `errSecItemNotFound` — nothing left to delete — counts as success. That is
    /// the ordinary case: most launches have nothing to migrate.
    func testMigrationSucceedsWhenThereIsNothingToMigrate() {
        let keychain = KeychainStore()
        keychain.migrateAwayFromStoredCredentials()
        XCTAssertTrue(keychain.migrateAwayFromStoredCredentials())
        XCTAssertNil(keychain.readLegacyAPIKeyForTesting())
        XCTAssertNil(keychain.readLegacyBackendTokenForTesting())
    }

    /// The call site the brief names directly: both must be gone after
    /// `TutorStore.init` runs, on every launch — not just a debug-flagged one.
    @MainActor
    func testTutorStoreInitClearsBothLegacyCredentials() {
        let keychain = KeychainStore()
        keychain.saveLegacyAPIKeyForTesting("sk-should-not-survive-either")
        keychain.saveLegacyBackendTokenForTesting("nor-should-this")

        _ = TutorStore(service: DemoTutorService(), persistence: .inMemory, keychain: keychain)

        XCTAssertNil(keychain.readLegacyAPIKeyForTesting())
        XCTAssertNil(keychain.readLegacyBackendTokenForTesting())
    }

    // MARK: - The address is a constant, not a setting

    /// The whole reason this app has no server field: there is one address, it is
    /// in the binary, and it is reachable without anything configured on device.
    func testThePermanentAddressIsAWholeHTTPSURL() {
        let url = BackendConfiguration.permanentBaseURL
        XCTAssertEqual(url.scheme, "https", "the device must never be pointed at cleartext")
        XCTAssertNotNil(url.host)
    }

    /// Nothing about the address is persisted, so nothing a previous launch or a
    /// `UserDefaults` writer left behind can redirect the app.
    func testAStaleStoredAddressCannotOverrideThePermanentOne() throws {
        let suiteName = "SettingsBackendTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("https://leftover.example.com", forKey: "mathTutor.backendBaseURL")

        XCTAssertNotEqual(BackendConfiguration.permanentBaseURL.host, "leftover.example.com")
    }

    // MARK: - The token is compiled in

    /// **The bug this design replaces.** The token used to be seeded into the
    /// Keychain from the launch environment, which only works when something
    /// launches the app *with* that environment — Xcode, `devicectl`,
    /// `run-sim.sh`. A Release build installed on an iPad and started by tapping
    /// its icon had no launching process to take a token from, so it could never
    /// reach the backend at all. It is a build setting now, so a tapped build
    /// carries its own credential.
    ///
    /// This asserts the wiring rather than a value: the test bundle's own
    /// `Info.plist` is not the app's, so `bundledToken` may legitimately be nil
    /// here. What must hold is that the key is read from the bundle at all, and
    /// that an absent or blank one collapses to nil rather than to `""`.
    func testTheTokenIsReadFromTheBundleAndBlankMeansAbsent() {
        XCTAssertEqual(BackendConfiguration.tokenInfoKey, "MathTutorBackendToken")
        if let token = BackendConfiguration.bundledToken {
            XCTAssertFalse(token.isEmpty, "a blank build setting must read as no token, not as an empty one")
            XCTAssertEqual(token, token.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// An empty token is unusable, and treated exactly like no configuration at
    /// all rather than as a half-configured state anyone has to check for.
    func testAnEmptyTokenIsTreatedAsNoConfigurationAtAll() {
        XCTAssertNil(BackendConfiguration(baseURL: nil, token: "t"))
        XCTAssertNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: ""))
        XCTAssertNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: "   "))
        XCTAssertNotNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: "t"))
    }

    /// `load()` is all-or-nothing, and agrees with `bundledToken` about which.
    /// A build with a token gets the permanent address paired with it; a build
    /// without one gets nothing to send.
    func testLoadIsConfiguredExactlyWhenTheBuildHasAToken() {
        let configuration = BackendConfiguration.load()

        if let token = BackendConfiguration.bundledToken {
            let loaded = try? XCTUnwrap(configuration)
            XCTAssertEqual(loaded?.token, token)
            XCTAssertEqual(loaded?.baseURL, BackendConfiguration.permanentBaseURL)
        } else {
            XCTAssertNil(configuration, "no token compiled in means nothing to send")
        }
    }

    /// `usesLiveTutor` follows the same single answer, read once at launch —
    /// there is nothing left in the app that could change it mid-session.
    @MainActor
    func testUsesLiveTutorAgreesWithTheLoadedConfiguration() {
        let store = TutorStore(service: DemoTutorService(), persistence: .inMemory)
        XCTAssertEqual(store.usesLiveTutor, BackendConfiguration.load() != nil)
    }
}
