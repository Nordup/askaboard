import Foundation
import Security

/// **The app stores no credential.** This type exists only to clear the two it
/// used to, and it only ever deletes.
///
/// The device's bearer token is compiled into the build now — see
/// `BackendConfiguration` — because a build the user taps has no launching
/// process to take one from. Before that it was seeded into the Keychain at
/// launch, and before *that* the Keychain held a real OpenAI API key typed into
/// Settings. Both accounts can still be sitting on a device that ran an older
/// build, holding a credential the app has stopped sending anywhere, so
/// `migrateAwayFromStoredCredentials()` runs on every launch, release included.
struct KeychainStore: Sendable {
    private let service = "com.nordup.MathTutor"
    /// Where the device token lived while it was seeded at launch.
    private let legacyBackendTokenAccount = "backend-token"
    /// Where the client-side OpenAI prototype kept its key.
    private let legacyAPIKeyAccount = "openai-api-key"

    /// Deletes whatever either legacy account still holds. `errSecItemNotFound`
    /// — nothing left to delete — counts as success, which is the ordinary case
    /// on any device that never ran one of those builds.
    @discardableResult
    func migrateAwayFromStoredCredentials() -> Bool {
        let apiKey = remove(account: legacyAPIKeyAccount)
        let backendToken = remove(account: legacyBackendTokenAccount)
        return apiKey && backendToken
    }

    #if DEBUG
    /// Test-only: writes directly to a legacy account, so a migration test can
    /// seed the exact condition `migrateAwayFromStoredCredentials()` exists to
    /// clear, without this type exposing those accounts to anything else.
    @discardableResult
    func saveLegacyAPIKeyForTesting(_ key: String) -> Bool {
        save(key, account: legacyAPIKeyAccount)
    }

    func readLegacyAPIKeyForTesting() -> String? {
        read(account: legacyAPIKeyAccount)
    }

    @discardableResult
    func saveLegacyBackendTokenForTesting(_ token: String) -> Bool {
        save(token, account: legacyBackendTokenAccount)
    }

    func readLegacyBackendTokenForTesting() -> String? {
        read(account: legacyBackendTokenAccount)
    }
    #endif

    private func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    private func save(_ value: String, account: String) -> Bool {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        var addQuery = query
        addQuery[kSecValueData as String] = data
        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    private func remove(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
