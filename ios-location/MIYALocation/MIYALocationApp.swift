import SwiftUI

@main
struct MIYALocationApp: App {
    @StateObject private var recorder = LocationRecorder()
    init() {
        LocationBackgroundRefresh.register()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(recorder)
                .onAppear { LocationBackgroundRefresh.schedule() }
        }
    }
}
