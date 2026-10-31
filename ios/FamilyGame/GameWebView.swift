import SwiftUI
import WebKit
import AVFoundation

/// Hosts the bundled Zing web game inside a WKWebView and bridges haptics and
/// text-to-speech to native iOS. All game content ships inside the app bundle;
/// nothing is loaded from the network.
struct GameWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(context.coordinator, name: "zing")

        // Mark the environment as native (with phone linking available) so the page can use the bridges.
        let flag = WKUserScript(source: "window.__ZING_NATIVE__ = true; window.__ZING_MP__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(flag)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        context.coordinator.multipeer.webView = webView
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x12 / 255, green: 0x0d / 255, blue: 0x2b / 255, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false

        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            let webRoot = indexURL.deletingLastPathComponent()
            webView.loadFileURL(indexURL, allowingReadAccessTo: webRoot)
        } else {
            webView.loadHTMLString("<h1 style='font-family:-apple-system;color:white;padding:40px'>Game files missing from bundle.</h1>", baseURL: nil)
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.multipeer.stop()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "zing")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let multipeer = MultipeerBridge()
        private let synthesizer = AVSpeechSynthesizer()
        private let light = UIImpactFeedbackGenerator(style: .light)
        private let medium = UIImpactFeedbackGenerator(style: .medium)
        private let heavy = UIImpactFeedbackGenerator(style: .heavy)
        private let notify = UINotificationFeedbackGenerator()
        private let selection = UISelectionFeedbackGenerator()

        override init() {
            super.init()
            light.prepare(); medium.prepare(); notify.prepare()
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "haptic":
                haptic(kind: body["kind"] as? String ?? "light")
            case "speak":
                speak(text: body["text"] as? String ?? "")
            case "stopSpeak":
                synthesizer.stopSpeaking(at: .immediate)
            case "mp":
                multipeer.handle(body)
            default:
                break
            }
        }

        private func haptic(kind: String) {
            switch kind {
            case "light": light.impactOccurred()
            case "medium": medium.impactOccurred()
            case "heavy": heavy.impactOccurred()
            case "selection": selection.selectionChanged()
            case "success": notify.notificationOccurred(.success)
            case "warning": notify.notificationOccurred(.warning)
            case "error": notify.notificationOccurred(.error)
            default: light.impactOccurred()
            }
        }

        private func speak(text: String) {
            guard !text.isEmpty else { return }
            synthesizer.stopSpeaking(at: .immediate)
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: "en-GB") ?? AVSpeechSynthesisVoice(language: "en-US")
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
            utterance.pitchMultiplier = 1.0
            synthesizer.speak(utterance)
        }

        // Keep every navigation inside the bundled game. External links are ignored.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = navigationAction.request.url, url.isFileURL || url.absoluteString == "about:blank" {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }
    }
}
