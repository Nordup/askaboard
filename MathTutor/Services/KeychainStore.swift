import Foundation
import Security

/// The device's backend credential: a bearer token, kept in the Keychain and
/// nowhere else. The base URL it is paired with is not a secret and lives in
/// `UserDefaults` instead — see `BackendConfiguration`.
struct KeychainStore: Sendable {
    private let service = "com.nordup.MathTutor"
    /// The account this type reads and writes today. Named for what it holds
    /// now — a backend bearer token — rather than for the client-side OpenAI
    /// prototype that used to occupy this slot.
    private let account = "backend-token"
    /// Where the client-side OpenAI prototype kept its key. `migrateAwayFromAPIKey()`
    /// is the only thing that still touches this account, and it only ever deletes.
    private let legacyAPIKeyAccount = "openai-api-key"

    func readBackendToken() -> String? {
        read(account: account)
    }

    @discardableResult
    func saveBackendToken(_ token: String) -> Bool {
        save(token, account: account)
    }

    @discardableResult
    func removeBackendToken() -> Bool {
        remove(account: account)
    }

    /// Deletes whatever the old `openai-api-key` account still holds. Meant to run on every
    /// launch — including release builds — so a real OpenAI key from before this migration
    /// does not sit in the Keychain forever after the app stopped sending it anywhere.
    /// `errSecItemNotFound` (nothing left to delete) counts as success, the same way
    /// `removeBackendToken()` treats it.
    @discardableResult
    func migrateAwayFromAPIKey() -> Bool {
        remove(account: legacyAPIKeyAccount)
    }

    #if DEBUG
    /// Test-only: writes directly to the legacy `openai-api-key` account, so a migration test
    /// can seed the exact condition `migrateAwayFromAPIKey()` exists to clear, without this
    /// type exposing that account to anything else.
    @discardableResult
    func saveLegacyAPIKeyForTesting(_ key: String) -> Bool {
        save(key, account: legacyAPIKeyAccount)
    }

    /// Test-only: reads the legacy `openai-api-key` account directly.
    func readLegacyAPIKeyForTesting() -> String? {
        read(account: legacyAPIKeyAccount)
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
