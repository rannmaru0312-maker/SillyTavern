import SwiftUI

@main
struct MIYALocationApp: App {
    @StateObject private var recorder = LocationRecorder()
    var body: some Scene {
        WindowGroup { ContentView().environmentObject(recorder) }
    }
}
