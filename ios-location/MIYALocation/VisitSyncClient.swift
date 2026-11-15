import Foundation
import Combine

// API requests never follow redirects, which prevents sending private diary events
// or the login password to a different host.
private final class BlockRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private struct CSRFReply: Decodable { let token: String }
private struct LoginReply: Decodable { let handle: String }
private struct MeReply: Decodable { let handle: String }
private struct ImportReply: Decodable {
    let success: Bool
    let added: Int
    let duplicates: Int
}
private struct DeleteReply: Decodable {
    let success: Bool
    let deleted: Int
}
private struct VisitPayload: Encodable {
    let events: [RemoteVisitEvent]
}
private struct ExportReply: Decodable {
    let version: Int
    let events: [RemoteVisitEvent]
}
private struct RemoteVisitEvent: Codable, Equatable {
    let event_id: String
    let place_id: String
    let place_name: String
    let kind: String
    let detected_at: String
    let confirmed_at: String?
    let source: String
    let schema_version: Int

    init(_ event: VisitEvent, formatter: ISO8601DateFormatter) {
        event_id = event.id.uuidString.lowercased()
        place_id = event.placeID.uuidString.lowercased()
        place_name = event.placeName.trimmingCharacters(in: .whitespacesAndNewlines)
        kind = event.type
        detected_at = formatter.string(from: event.detectedAt)
        confirmed_at = event.confirmedAt.map { formatter.string(from: $0) }
        source = "ios_geofence"
        schema_version = 1
    }
}

@MainActor final class VisitSyncClient: ObservableObject {
    @Published private(set) var isBusy = false
    @Published private(set) var isSignedIn = false
    @Published private(set) var statusMessage = "サーバーへの送信は無効です"
    @Published private(set) var connectedHost = ""
    @Published var consentToUpload = false

    private var baseURL: URL?
    private var csrfToken: String?
    // Ephemeral cookies are deliberately not written to disk. Login is needed again
    // after app restart. No password, token or GPS coordinate is embedded in the app.
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config, delegate: BlockRedirects(), delegateQueue: nil)
    }()

    private func validatedBaseURL(_ input: String) throws -> URL {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              (parts.path.isEmpty || parts.path == "/"),
              let base = parts.url else {
            throw APIError(message: "HTTPSの正規サーバーURLを入力してください（末尾は / のみ）")
        }
        return base
    }

    private func request(base: URL, endpoint: String, method: String = "GET",
                         body: Data? = nil, token: String? = nil) async throws -> Data {
        let url = base.appendingPathComponent(endpoint)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token {
            request.setValue(token, forHTTPHeaderField: "x-csrf-token")
        }
        let (data, response) = try await session.data(for: request)
        guard let reply = response as? HTTPURLResponse else {
            throw APIError(message: "サーバーの応答を確認できません")
        }
        guard (200...299).contains(reply.statusCode) else {
            throw APIError(message: "サーバーがHTTP \(reply.statusCode)を返しました。認証・設定・通信を確認してください")
        }
        return data
    }

    private func fetchToken(base: URL) async throws -> String {
        let response = try await request(base: base, endpoint: "csrf-token")
        let token = try JSONDecoder().decode(CSRFReply.self, from: response).token
        guard token != "disabled", !token.isEmpty, token.count <= 200 else {
            throw APIError(message: "サーバーのCSRF保護が無効または不明のため接続しません")
        }
        return token
    }

    func signIn(serverURL: String, handle: String, password: String) async {
        guard !isBusy else { return }
        isBusy = true
        isSignedIn = false
        baseURL = nil
        csrfToken = nil
        connectedHost = ""
        defer { isBusy = false }
        do {
            guard !handle.isEmpty, handle.count <= 64,
                  handle.range(of: #"^[a-zA-Z0-9_-]+$"#, options: .regularExpression) != nil else {
                throw APIError(message: "ログインIDを確認してください")
            }
            let base = try validatedBaseURL(serverURL)
            let token = try await fetchToken(base: base)
            let payload = try JSONSerialization.data(withJSONObject: ["handle": handle, "password": password])
            let data = try await request(base: base, endpoint: "api/users/login",
                                         method: "POST", body: payload, token: token)
            let loggedIn = try JSONDecoder().decode(LoginReply.self, from: data)
            guard loggedIn.handle == handle else { throw APIError(message: "ログインアカウントが一致しません") }
            let me = try await request(base: base, endpoint: "api/users/me")
            guard try JSONDecoder().decode(MeReply.self, from: me).handle == handle else {
                throw APIError(message: "サーバー側のログイン確認に失敗しました")
            }
            csrfToken = try await fetchToken(base: base)
            baseURL = base
            isSignedIn = true
            connectedHost = base.host ?? ""
            statusMessage = "本人アカウントで接続済み。記録はまだ送信していません"
        } catch {
            statusMessage = "接続失敗: \(error.localizedDescription)"
        }
    }

    func uploadAndVerify(events: [VisitEvent]) async {
        guard !isBusy else { return }
        guard consentToUpload, isSignedIn, let base = baseURL, let csrfToken else {
            statusMessage = "本人の送信許可とログインが必要です"
            return
        }
        guard !events.isEmpty else { statusMessage = "送信する訪問記録がありません"; return }
        isBusy = true
        defer { isBusy = false }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let payload = events.map { RemoteVisitEvent($0, formatter: formatter) }
        let unique = Dictionary(grouping: payload, by: \.event_id)
        guard unique.count == payload.count else {
            statusMessage = "重複したイベントIDを検出しました。送信を中止します"; return
        }
        let expected = Dictionary(uniqueKeysWithValues: payload.map { ($0.event_id, $0) })
        var checked = 0
        do {
            // Deliberately foreground-only and opt-in; never send from GPS callbacks.
            for start in stride(from: 0, to: payload.count, by: 20) {
                guard consentToUpload else { throw APIError(message: "送信許可が無効です") }
                let end = min(start + 20, payload.count)
                let bytes = try JSONEncoder().encode(VisitPayload(events: Array(payload[start..<end])))
                let answer = try await request(base: base, endpoint: "api/plugins/miya-memory/visits/import-v1",
                                               method: "POST", body: bytes, token: csrfToken)
                let receipt = try JSONDecoder().decode(ImportReply.self, from: answer)
                guard receipt.success, receipt.added + receipt.duplicates == end - start else {
                    throw APIError(message: "サーバーが受信件数を確認できませんでした")
                }
                checked = end
            }

            // A successful POST is never reported as a successful sync without read-back.
            let readback = try await request(base: base, endpoint: "api/plugins/miya-memory/visits/export-v1")
            let remote = try JSONDecoder().decode(ExportReply.self, from: readback)
            guard remote.version == 1 else { throw APIError(message: "読戻しのデータ形式が異なります") }
            let groups = Dictionary(grouping: remote.events, by: \.event_id)
            guard groups.values.allSatisfy({ $0.count == 1 }) else {
                throw APIError(message: "サーバーから重複したイベントIDが返されました")
            }
            let serverEvents = groups.compactMapValues { $0.first }
            guard expected.allSatisfy({ key, value in serverEvents[key] == value }) else {
                throw APIError(message: "保存内容の照合が一致しませんでした")
            }
            statusMessage = "\(payload.count)件を送信し、サーバーからの読み戻し照合も成功しました。Googleドライブの7日分保存は別途確認が必要です"
        } catch {
            statusMessage = "送信・確認を完了できませんでした（\(checked)/\(payload.count)件まで受信応答）。\(error.localizedDescription)"
        }
    }

    func eraseRemoteVisits() async {
        guard !isBusy else { return }
        guard isSignedIn, let base = baseURL, let csrfToken else {
            statusMessage = "サーバーの記録を削除するには本人のログインが必要です"
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["confirm": "DELETE_MY_VISIT_EVENTS"])
            let response = try await request(base: base,
                                             endpoint: "api/plugins/miya-memory/visits/delete-v1",
                                             method: "POST", body: body, token: csrfToken)
            let reply = try JSONDecoder().decode(DeleteReply.self, from: response)
            guard reply.success else { throw APIError(message: "削除完了の応答がありません") }
            let saved = try await request(base: base,
                                          endpoint: "api/plugins/miya-memory/visits/export-v1")
            let verification = try JSONDecoder().decode(ExportReply.self, from: saved)
            guard verification.version == 1, verification.events.isEmpty else {
                throw APIError(message: "削除後の読み戻し確認が一致しません")
            }
            consentToUpload = false
            statusMessage = "サーバー側の \(reply.deleted)件を削除・確認しました。端末内の記録は残ります。再送信するには改めて許可が必要です"
        } catch {
            statusMessage = "サーバー削除を確認できませんでした: \(error.localizedDescription)"
        }
    }

    func signOut() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        if let base = baseURL, let token = csrfToken {
            _ = try? await request(base: base, endpoint: "api/users/logout",
                                   method: "POST", token: token)
        }
        session.configuration.httpCookieStorage?.cookies?.forEach {
            session.configuration.httpCookieStorage?.deleteCookie($0)
        }
        baseURL = nil
        csrfToken = nil
        isSignedIn = false
        connectedHost = ""
        consentToUpload = false
        statusMessage = "端末側の接続を終了しました"
    }
}
