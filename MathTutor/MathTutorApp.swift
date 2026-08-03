import SwiftUI

extension AppAppearance {
    var colorScheme: ColorScheme? {
        switch self {
        case .light: .light
        case .system: nil
        case .dark: .dark
        }
    }
}

@main
struct MathTutorApp: App {
    @StateObject private var store = TutorStore()
    @AppStorage(AppearancePreference.key) private var appearanceRawValue = AppearancePreference.defaultValue.rawValue

    private var appearance: AppAppearance {
        AppAppearance(rawValue: appearanceRawValue) ?? AppearancePreference.defaultValue
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .preferredColorScheme(appearance.colorScheme)
        }
    }
}
