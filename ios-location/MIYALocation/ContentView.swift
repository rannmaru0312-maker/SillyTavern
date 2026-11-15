import SwiftUI
import CoreLocation

struct ContentView: View {
    @EnvironmentObject private var recorder: LocationRecorder
    @StateObject private var sync = VisitSyncClient()
    @State private var serverURL = ""
    @State private var loginHandle = ""
    @State private var loginPassword = ""
    @State private var placeName = ""
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var exportURL: URL?
    @State private var showDelete = false
    var body: some View {
        NavigationStack {
            Form {
                Section("位置情報") {
                    Text("許可状態: \(authorizationText)")
                    Button("位置情報の許可を確認") { recorder.requestPermission() }
                    Button("現在地の座標を取得") { recorder.locate() }
                    if let p = recorder.currentLocation {
                        Text("取得座標: \(p.latitude), \(p.longitude)").font(.caption)
                        Button("取得した座標を入力") {
                            latitude = String(p.latitude)
                            longitude = String(p.longitude)
                        }
                    }
                    if recorder.monitoring {
                        Button("監視を停止", role: .destructive) { recorder.stopMonitoring() }
                    } else {
                        Button("登録地点の監視を開始") { recorder.startMonitoring() }
                    }
                }
                Section("訪問先を登録") {
                    TextField("場所名", text: $placeName)
                    TextField("緯度", text: $latitude).keyboardType(.numbersAndPunctuation)
                    TextField("経度", text: $longitude).keyboardType(.numbersAndPunctuation)
                    Button("登録") {
                        guard let lat = Double(latitude), let lon = Double(longitude) else {
                            recorder.errorMessage = "緯度・経度を数字で入力してください"; return
                        }
                        recorder.addPlace(name: placeName, latitude: lat, longitude: lon)
                        placeName = ""
                    }
                    Text("GPSは建物への入退店を保証しません。検知時刻は推定です。").font(.caption)
                }
                Section("登録地点") {
                    ForEach(recorder.places) { place in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(place.name)
                                Text("\(place.latitude), \(place.longitude)").font(.caption)
                            }
                            Spacer()
                            Button("削除", role: .destructive) { recorder.deletePlace(place.id) }
                        }
                    }
                }
                Section("訪問記録") {
                    ForEach(recorder.events.reversed()) { event in
                        VStack(alignment: .leading, spacing: 5) {
                            Text("\(event.placeName) / \(event.type == "entry" ? "到着推定" : "退出推定")")
                            Text(event.detectedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                            if let date = event.confirmedAt {
                                Text("確認済み: \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                            }
                            Button("検知時刻を確認済みにする") { recorder.confirm(event.id, at: event.detectedAt) }
                        }
                    }
                    if let exportURL {
                        ShareLink("CSVを共有", item: exportURL)
                    }
                    Button("CSVファイルを作成") { exportURL = recorder.exportCSV() }
                }
                Section("サーバーへの手動同期（任意）") {
                    Text("利用者が許可した場合だけ、登録先の名前・到着/退出種別・推定/確認時刻を送信します。GPS座標や移動経路は送信しません。")
                        .font(.caption)
                    TextField("https://正規サーバーURL", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("ログインID", text: $loginHandle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("パスワード（端末には保存しません）", text: $loginPassword)
                    if sync.isSignedIn {
                        Text("接続先: \(sync.connectedHost)").font(.caption)
                        Button("ログアウト") {
                            Task { await sync.signOut() }
                        }.disabled(sync.isBusy)
                    } else {
                        Button("HTTPSサーバーへログイン") {
                            let password = loginPassword
                            loginPassword = ""
                            Task {
                                await sync.signIn(serverURL: serverURL,
                                                  handle: loginHandle, password: password)
                            }
                        }
                        .disabled(sync.isBusy || serverURL.isEmpty || loginHandle.isEmpty)
                    }
                    Toggle("訪問記録のサーバー送信を許可", isOn: $sync.consentToUpload)
                    Button("現在の訪問記録を送信し、サーバーから読み戻して照合") {
                        let snapshot = recorder.events
                        Task { await sync.uploadAndVerify(events: snapshot) }
                    }
                    .disabled(!sync.consentToUpload || !sync.isSignedIn ||
                              sync.isBusy || recorder.events.isEmpty)
                    if sync.isBusy { ProgressView("確認中") }
                    Text(sync.statusMessage).font(.caption)
                    Text("同期は手動操作のみです。iPhoneのアプリを閉じている間の送信や、Googleドライブへの保存はまだ行いません。")
                        .font(.caption)
                }
                Section("プライバシー") {
                    Text("記録は端末内に保存され、サーバーへ自動送信しません。").font(.caption)
                    Button("全地点・全記録を削除", role: .destructive) { showDelete = true }
                }
                if let message = recorder.errorMessage {
                    Section("確認が必要") { Text(message).foregroundStyle(.red) }
                }
            }
            .navigationTitle("みやの生活記録")
            .confirmationDialog("すべての地点と記録を削除しますか？", isPresented: $showDelete) {
                Button("完全削除", role: .destructive) { recorder.deleteAll() }
            }
        }
    }
    private var authorizationText: String {
        switch recorder.authorization {
        case .authorizedAlways: return "常に許可"
        case .authorizedWhenInUse: return "使用中のみ"
        case .denied: return "拒否"
        case .restricted: return "制限あり"
        default: return "未確認"
        }
    }
}
