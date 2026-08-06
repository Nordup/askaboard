import SwiftUI

@main
struct MathTutorApp: App {
    @StateObject private var store = TutorStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
    }
}
