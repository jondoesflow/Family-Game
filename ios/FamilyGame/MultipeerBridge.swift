import Foundation
import MultipeerConnectivity
import WebKit

/// Links phones over Bluetooth and peer-to-peer Wi-Fi using MultipeerConnectivity.
/// The web game drives it with {type:"mp", cmd:...} messages and receives events through
/// window.ZingNet._event({...}). Host phones advertise; joining phones browse and invite.
final class MultipeerBridge: NSObject {
    static let serviceType = "zing-quiz"   // 1-15 characters, letters, digits and hyphens only

    weak var webView: WKWebView?

    private var peerID: MCPeerID?
    private var session: MCSession?
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var found: [String: MCPeerID] = [:]

    // MARK: Commands from the web game

    func handle(_ body: [String: Any]) {
        let cmd = body["cmd"] as? String ?? ""
        switch cmd {
        case "host":
            start(name: body["name"] as? String ?? "Phone")
            let adv = MCNearbyServiceAdvertiser(peer: peerID!, discoveryInfo: nil, serviceType: MultipeerBridge.serviceType)
            adv.delegate = self
            adv.startAdvertisingPeer()
            advertiser = adv
            emit(["kind": "ready", "me": peerID!.displayName, "role": "host"])
        case "join":
            start(name: body["name"] as? String ?? "Phone")
            let br = MCNearbyServiceBrowser(peer: peerID!, serviceType: MultipeerBridge.serviceType)
            br.delegate = self
            br.startBrowsingForPeers()
            browser = br
            emit(["kind": "ready", "me": peerID!.displayName, "role": "join"])
        case "invite":
            guard let name = body["peer"] as? String, let peer = found[name], let session = session else { return }
            browser?.invitePeer(peer, to: session, withContext: nil, timeout: 30)
        case "send":
            guard let session = session, let payload = body["payload"] as? String, let data = payload.data(using: .utf8) else { return }
            let to = body["to"] as? String ?? ""
            let targets = to.isEmpty ? session.connectedPeers : session.connectedPeers.filter { $0.displayName == to }
            guard !targets.isEmpty else { return }
            do { try session.send(data, toPeers: targets, with: .reliable) }
            catch { emit(["kind": "error", "message": "Could not send to the other phone."]) }
        case "stop":
            stop()
        default:
            break
        }
    }

    private func start(name: String) {
        stop()
        // Display names must be unique within a session; a short random suffix keeps two "Mum's phone"s apart.
        let suffix = String(UUID().uuidString.prefix(4))
        let cleaned = name.replacingOccurrences(of: "#", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        let display = String((cleaned.isEmpty ? "Phone" : cleaned).prefix(40)) + "#" + suffix
        let id = MCPeerID(displayName: display)
        let s = MCSession(peer: id, securityIdentity: nil, encryptionPreference: .required)
        s.delegate = self
        peerID = id
        session = s
        found = [:]
    }

    func stop() {
        advertiser?.stopAdvertisingPeer(); advertiser = nil
        browser?.stopBrowsingForPeers(); browser = nil
        session?.disconnect(); session = nil
        peerID = nil
        found = [:]
    }

    // MARK: Events to the web game

    private func emit(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.ZingNet && window.ZingNet._event(\(json));", completionHandler: nil)
        }
    }

    private func emitPeers() {
        guard let session = session else { emit(["kind": "peers", "peers": []]); return }
        let peers = session.connectedPeers.map { ["id": $0.displayName, "name": $0.displayName, "state": "connected"] }
        emit(["kind": "peers", "peers": peers])
    }

    private func emitFound() {
        let peers = found.keys.sorted().map { ["id": $0, "name": $0] }
        emit(["kind": "found", "peers": peers])
    }
}

extension MultipeerBridge: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        emitPeers()
    }
    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        guard let payload = String(data: data, encoding: .utf8) else { return }
        emit(["kind": "message", "from": peerID.displayName, "payload": payload])
    }
    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

extension MultipeerBridge: MCNearbyServiceAdvertiserDelegate {
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        invitationHandler(true, session)   // family game: anyone nearby who taps the host's name may join
    }
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        emit(["kind": "error", "message": "Could not start hosting. Check Bluetooth and Wi-Fi are on."])
    }
}

extension MultipeerBridge: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        found[peerID.displayName] = peerID
        emitFound()
    }
    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        found.removeValue(forKey: peerID.displayName)
        emitFound()
    }
    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        emit(["kind": "error", "message": "Could not search for hosts. Check Bluetooth and Wi-Fi are on."])
    }
}
