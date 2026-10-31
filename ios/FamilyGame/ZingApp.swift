import SwiftUI
import AVFoundation

@main
struct ZingApp: App {
    init() {
        // Let the game's sounds play even when the ring/silent switch is on silent,
        // and mix with any music already playing.
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Audio session failures are not fatal; the game simply plays through the default route.
        }
        // A pass-the-phone game should never dim or lock mid-turn.
        UIApplication.shared.isIdleTimerDisabled = true
    }

    var body: some Scene {
        WindowGroup {
            GameWebView()
                .ignoresSafeArea()
                .background(Color(red: 0x12 / 255, green: 0x0d / 255, blue: 0x2b / 255))
                .preferredColorScheme(.dark)
                .persistentSystemOverlays(.hidden)
                .statusBarHidden(true)
        }
    }
}
