import SwiftUI

@main
struct MathTutorApp: App {
    @StateObject private var store = TutorStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                // The board's ink is written after the pen has rested rather than
                // after every stroke — see `TutorStore.updateDrawing` — so the one
                // thing that has to be caught is the app leaving before that rest
                // comes up. Leaving the foreground is exactly that moment, and it
                // is the moment iOS may not give the app another.
                .onChange(of: scenePhase) { _, phase in
                    if phase != .active { store.saveBoardInkNow() }
                }
        }
    }
}
