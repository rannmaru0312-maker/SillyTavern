import SwiftUI
import CoreLocation
import UniformTypeIdentifiers

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
    @State private var weekStart = VisitWeekExporter.mostRecentCompletedStart()
    @State private var weeklyExportURL: URL?
    @State private var weeklyExportMessage = "GPSで検知した出来事だけを書き出します"

    @State private var showDelete = false
    @State private var showEraseServer = false
    @State private var archiveURL: URL?
    @State private var showArchivePicker = false
    @State private var archiveStatus = "正確な座標はバックアップに含めません"
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
                        VisitEventRow(event: event) { confirmedDate in
                            recorder.confirm(event.id, at: confirmedDate)
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
                    if sync.isSignedIn {
                        Button("サーバー上の訪問記録を削除", role: .destructive) {
                            showEraseServer = true
                        }.disabled(sync.isBusy)
                    }
                    if sync.isBusy { ProgressView("確認中") }
                    Text(sync.statusMessage).font(.caption)
                    Text("同期は手動操作のみです。iPhoneのアプリを閉じている間の送信や、Googleドライブへの保存はまだ行いません。")
                        .font(.caption)
                }
                Section("7日分のGPS記録を書き出す") {
                    DatePicker("対象期間の開始日（日本時間）", selection: $weekStart,
                               in: ...VisitWeekExporter.mostRecentCompletedStart(),
                               displayedComponents: .date)
                    Text("選んだ日から連続する、終了済み7日間を対象にします。記録がない日を、訪問なしと断定しません。")
                        .font(.caption)
                    Button("7日分のCSVを作成する") {
                        do {
                            let result = try VisitWeekExporter.export(events: recorder.events,
                                                                      start: weekStart)
                            weeklyExportURL = result.file
                            weeklyExportMessage = "対象期間のGPS記録 \(result.eventCount)件を書き出しました。Googleドライブ保存はまだ実行していません。"
                        } catch {
                            weeklyExportURL = nil
                            weeklyExportMessage = error.localizedDescription
                        }
                    }
                    if let weeklyExportURL {
                        ShareLink("7日分のCSVを共有・保存", item: weeklyExportURL)
                    }
                    Text(weeklyExportMessage).font(.caption)
                    Text("本人確認済みの時刻と、GPS推定・未確認の時刻を分けて書き出します。保存後の読み戻しは別途必要です。")
                        .font(.caption)
                }
                Section("訪問記録のバックアップと復元（手動）") {
                    Button("記録のJSONバックアップを作成") {
                        archiveURL = recorder.exportEventArchive()
                        archiveStatus = archiveURL == nil ?
                            "バックアップを作成できませんでした" :
                            "記録のバックアップを作成しました。必要に応じて「ファイル」へ保存してください。"
                    }
                    if let archiveURL {
                        ShareLink("バックアップを共有・ファイルに保存", item: archiveURL)
                    }
                    Button("JSONバックアップから復元する") { showArchivePicker = true }
                    Text(archiveStatus).font(.caption)
                    Text("記録ID・訪問先名・日時を保存します。座標は含みません。インポートは既存の記録を削除せず、重複・衝突を確認します。")
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
            .alert("サーバーの訪問記録をすべて削除しますか？", isPresented: $showEraseServer) {
                Button("削除する", role: .destructive) {
                    Task { await sync.eraseRemoteVisits() }
                }
                Button("中止", role: .cancel) {}
            } message: {
                Text("ログイン中の本人アカウントのサーバー記録を削除します。iPhone内の記録は残るため、後から送信すると再登録されます。")
            }
            .fileImporter(isPresented: $showArchivePicker,
                          allowedContentTypes: [.json],
                          allowsMultipleSelection: false) { result in
                do {
                    guard let url = try result.get().first else {
                        archiveStatus = "ファイルが選択されませんでした"
                        return
                    }
                    if recorder.restoreEventArchive(from: url) {
                        archiveStatus = "復元が完了しました。記録IDを照合して、既存の訪問を重複させず統合しました。"
                    } else {
                        archiveStatus = "復元できませんでした。エラー表示を確認してください。"
                    }
                } catch {
                    archiveStatus = "ファイルを読み込めませんでした: \(error.localizedDescription)"
                }
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


private struct VisitEventRow: View {
    let event: VisitEvent
    let onConfirm: (Date) -> Void
    @State private var proposedTime: Date

    init(event: VisitEvent, onConfirm: @escaping (Date) -> Void) {
        self.event = event
        self.onConfirm = onConfirm
        _proposedTime = State(initialValue: event.confirmedAt ?? event.detectedAt)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("\(event.placeName) / \(event.type == "entry" ? "到着の推定" : "退出の推定")")
                .font(.headline)
            Text("GPS検知（推定）：\(event.detectedAt.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption)
            if let confirmed = event.confirmedAt {
                Text("本人確認：\(confirmed.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption)
            } else {
                Text("本人未確認").font(.caption)
            }
            DatePicker("実際の日時に修正", selection: $proposedTime,
                       displayedComponents: [.date, .hourAndMinute])
            Button("この日時で確定・保存") { onConfirm(proposedTime) }
        }
    }
}
