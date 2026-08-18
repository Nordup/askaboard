import SwiftUI

@main
struct MathTutorApp: App {
    @StateObject private var store = TutorStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                // Ink and camera changes are written after the board has rested
                // rather than at pen/gesture frequency, so the one thing that has
                // to be caught is the app leaving before that rest comes up.
                // Leaving the foreground is exactly that moment, and it is the
                // moment iOS may not give the app another.
                .onChange(of: scenePhase) { _, phase in
                    if phase != .active { store.saveBoardStateNow() }
                }
        }
    }
}
