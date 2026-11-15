import Foundation
import CoreLocation

struct VisitPlace: Codable, Identifiable {
    let id: UUID
    var name: String
    var latitude: Double
    var longitude: Double
    var radius: Double
}
struct VisitEvent: Codable, Identifiable {
    let id: UUID
    let placeID: UUID
    let placeName: String
    let type: String
    let detectedAt: Date
    var confirmedAt: Date?
}

@MainActor final class LocationRecorder: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var places: [VisitPlace] = []
    @Published private(set) var events: [VisitEvent] = []
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined
    @Published private(set) var monitoring = false
    @Published var errorMessage: String?
    @Published private(set) var weeklyArchiveEnabled = UserDefaults.standard.bool(forKey: "miya-weekly-local-archive-enabled")
    @Published private(set) var weeklyArchiveStatus = "7日ごとの端末内保管は未設定です。Googleドライブへの自動保存ではありません。"
    @Published private(set) var latestWeeklyArchiveURL: URL?
    @Published private(set) var currentLocation: CLLocationCoordinate2D?
    private let manager = CLLocationManager()
    private let prefix = "miya-visit-"
    private let intentKey = "miya-location-intent"
    private let weeklyEnabledKey = "miya-weekly-local-archive-enabled"
    private let weeklyStartKey = "miya-weekly-local-archive-anchor"
    private let baseURL: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    private var placesURL: URL { baseURL.appendingPathComponent("places.json") }
    private var eventsURL: URL { baseURL.appendingPathComponent("events.json") }
    private var weeklyArchivesURL: URL { baseURL.appendingPathComponent("weekly-archives", isDirectory: true) }

    override init() {
        super.init()
        manager.delegate = self
        authorization = manager.authorizationStatus
        places = load([VisitPlace].self, from: placesURL) ?? []
        events = load([VisitEvent].self, from: eventsURL) ?? []
        monitoring = UserDefaults.standard.bool(forKey: intentKey)
        if !monitoring { stopRegions() } else if authorization == .authorizedAlways { startMonitoring() }
        if weeklyArchiveEnabled { refreshWeeklyArchives() }
    }
    private func load<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
    @discardableResult private func save<T: Encodable>(_ value: T, to url: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
            // Region events may arrive with the device locked. Files remain
            // protected until the first unlock after each reboot.
            try JSONEncoder().encode(value).write(
                to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return true
        } catch { errorMessage = "保存失敗: \(error.localizedDescription)"; return false }
    }
    func requestPermission() {
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        case .authorizedAlways: break
        default: errorMessage = "iPhoneの設定で位置情報の許可を確認してください"
        }
    }
    func locate() {
        guard CLLocationManager.locationServicesEnabled() else { errorMessage = "位置情報が無効です"; return }
        guard authorization == .authorizedAlways || authorization == .authorizedWhenInUse else {
            requestPermission(); return
        }
        manager.requestLocation()
    }
    func addPlace(name: String, latitude: Double, longitude: Double, radius: Double = 150) {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              (-90...90).contains(latitude), (-180...180).contains(longitude),
              (100...1000).contains(radius), places.count < 20 else {
            errorMessage = "場所名・座標・半径(100〜1000m)・登録上限20件を確認してください"; return
        }
        let old = places
        places.append(VisitPlace(id: UUID(), name: name, latitude: latitude, longitude: longitude, radius: radius))
        if !save(places, to: placesURL) { places = old; return }
        if monitoring { startMonitoring() }
    }
    func deletePlace(_ id: UUID) {
        let old = places
        places.removeAll { $0.id == id }
        guard save(places, to: placesURL) else { places = old; return }
        if monitoring { startMonitoring() }
    }
    func startMonitoring() {
        guard manager.authorizationStatus == .authorizedAlways else {
            errorMessage = "バックグラウンド検知には位置情報の『常に許可』が必要です"; return
        }
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self), !places.isEmpty else {
            errorMessage = "監視できません。登録地点と端末の対応状況を確認してください"; return
        }
        stopRegions()
        for place in places {
            let region = CLCircularRegion(center: .init(latitude: place.latitude, longitude: place.longitude),
                radius: min(place.radius, manager.maximumRegionMonitoringDistance),
                identifier: prefix + place.id.uuidString)
            region.notifyOnEntry = true
            region.notifyOnExit = true
            manager.startMonitoring(for: region)
        }
        monitoring = true
        UserDefaults.standard.set(true, forKey: intentKey)
        errorMessage = nil
    }
    private func stopRegions() {
        manager.monitoredRegions.filter { $0.identifier.hasPrefix(prefix) }.forEach { manager.stopMonitoring(for: $0) }
    }
    func stopMonitoring() {
        monitoring = false
        UserDefaults.standard.set(false, forKey: intentKey)
        stopRegions()
    }
    func confirm(_ id: UUID, at date: Date) {
        guard let i = events.firstIndex(where: { $0.id == id }) else { return }
        let old = events
        events[i].confirmedAt = date
        if !save(events, to: eventsURL) { events = old }
        else if weeklyArchiveEnabled { refreshWeeklyArchives() }
    }
    func deleteAll() {
        stopMonitoring()
        let oldPlaces = places
        let oldEvents = events
        places = []
        events = []
        if !save(places, to: placesURL) { places = oldPlaces }
        if !save(events, to: eventsURL) { events = oldEvents }
    }
    /// Archives completed seven-day periods locally when the app becomes active,
    /// or after a new event / time confirmation. The OS does not guarantee
    /// automatic execution at a particular clock time.
    func enableWeeklyArchives(from date: Date) {
        guard let calendar = VisitWeekExporter.japanCalendar() else {
            weeklyArchiveStatus = "日本時間を取得できません"
            return
        }
        let start = calendar.startOfDay(for: date)
        guard start <= calendar.startOfDay(for: Date()) else {
            weeklyArchiveStatus = "未来の日付からは開始できません"
            return
        }
        UserDefaults.standard.set(start.timeIntervalSince1970, forKey: weeklyStartKey)
        UserDefaults.standard.set(true, forKey: weeklyEnabledKey)
        weeklyArchiveEnabled = true
        refreshWeeklyArchives()
    }

    func disableWeeklyArchives() {
        UserDefaults.standard.set(false, forKey: weeklyEnabledKey)
        weeklyArchiveEnabled = false
        weeklyArchiveStatus = "端末内の週次保管を停止しました。以前のバックアップは削除していません。"
    }

    func refreshWeeklyArchives(now: Date = Date()) {
        guard weeklyArchiveEnabled else { return }
        let timestamp = UserDefaults.standard.double(forKey: weeklyStartKey)
        guard timestamp >= 946_684_800 else {
            weeklyArchiveStatus = "週次保管の開始日を設定し直してください"
            return
        }
        do {
            let report = try VisitLocalWeekArchive.writeCompleted(
                events: events, anchor: Date(timeIntervalSince1970: timestamp),
                now: now, directory: weeklyArchivesURL
            )
            latestWeeklyArchiveURL = report.lastFile
            weeklyArchiveStatus =
                "端末内の7日分を照合：新規\(report.created)件、既存確認済み\(report.alreadyVerified)件。" +
                (report.hasMoreCompletedPeriods ? "未処理の期間が残っています。もう一度確認してください。" : "") +
                " Googleドライブへはまだ保存していません。"
        } catch {
            weeklyArchiveStatus = "週次保管を確認できませんでした：\(error.localizedDescription)"
        }
    }

    /// User-triggered archive of event IDs and timestamps; exact coordinates are excluded.
    func exportEventArchive() -> URL? {
        do {
            let data = try VisitArchive.create(events)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("miya-visit-backup-\(UUID().uuidString).json")
            try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
            return url
        } catch {
            errorMessage = "バックアップ作成に失敗しました: \(error.localizedDescription)"
            return nil
        }
    }

    /// Import requires a user-selected local file and never sends data to a server.
    @discardableResult func restoreEventArchive(from url: URL) -> Bool {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let bytes = try Data(contentsOf: url)
            let merged = try VisitArchive.merge(current: events, archive: bytes)
            let old = events
            events = merged
            if !save(events, to: eventsURL) {
                events = old
                return false
            }
            return true
        } catch {
            errorMessage = "バックアップ復元を中止しました: \(error.localizedDescription)"
            return false
        }
    }

    func exportCSV() -> URL? {
        func quote(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }
        let formatter = ISO8601DateFormatter()
        let header = "id,place_id,place_name,type,detected_at,confirmed_at"
        let lines = events.map { e in
            [e.id.uuidString,e.placeID.uuidString,e.placeName,e.type,formatter.string(from: e.detectedAt),
             e.confirmedAt.map { formatter.string(from: $0) } ?? ""].map(quote).joined(separator: ",")
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("miya-visits-\(UUID().uuidString).csv")
        do { try ([header] + lines).joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8); return url }
        catch { errorMessage = "書き出し失敗: \(error.localizedDescription)"; return nil }
    }
    private func record(_ region: CLRegion, type: String) {
        guard monitoring, authorization == .authorizedAlways,
              region.identifier.hasPrefix(prefix),
              let id = UUID(uuidString: String(region.identifier.dropFirst(prefix.count))),
              let place = places.first(where: { $0.id == id }) else { return }
        let now = Date()
        if let previous = events.last(where: { $0.placeID == id && $0.type == type }),
           now.timeIntervalSince(previous.detectedAt) < 120 { return }
        let old = events
        events.append(VisitEvent(id: UUID(), placeID: id, placeName: place.name,
                                 type: type, detectedAt: now, confirmedAt: nil))
        if !save(events, to: eventsURL) { events = old }
        else if weeklyArchiveEnabled { refreshWeeklyArchives() }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorization = manager.authorizationStatus
        if authorization != .authorizedAlways && monitoring { stopMonitoring() }
        else if authorization == .authorizedAlways && monitoring { startMonitoring() }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        currentLocation = locations.last?.coordinate
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        errorMessage = error.localizedDescription
    }
    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) { record(region, type: "entry") }
    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) { record(region, type: "exit") }
    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        errorMessage = "監視エラー: \(error.localizedDescription)"
    }
}
