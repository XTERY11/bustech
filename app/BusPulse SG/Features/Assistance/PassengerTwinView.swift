import SwiftUI
import WebKit

/// The dashboard's bus digital twin (dashboard/app/passenger-twin) for the current hub journey.
/// The page reads the hub token from the URL fragment, which WebKit never sends to a server.
/// Presentation only: it is not a vehicle interface and does not confirm boarding.
struct PassengerTwinWebView: UIViewRepresentable {
    let url: URL
    let onFailure: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFailure: onFailure) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.isScrollEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        context.coordinator.load(url, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onFailure = onFailure
        if context.coordinator.loadedURL != url { context.coordinator.load(url, in: webView) }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var onFailure: () -> Void
        private(set) var loadedURL: URL?

        init(onFailure: @escaping () -> Void) {
            self.onFailure = onFailure
        }

        func load(_ url: URL, in webView: WKWebView) {
            loadedURL = url
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8))
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: any Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
               !(200..<300).contains(response.statusCode) {
                onFailure()
                return .cancel
            }
            return .allow
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        private func fail(_ error: any Error) {
            // A replaced load reports "cancelled"; that is not a failure of the dashboard.
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            onFailure()
        }
    }
}
