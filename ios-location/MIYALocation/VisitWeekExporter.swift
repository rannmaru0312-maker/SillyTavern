import Foundation

/// Exports only observed GPS visit events. It must never manufacture diary entries
/// or suggest that a week with no events means the user never visited anywhere.
enum VisitWeekExporter {
    struct Receipt {
        let file: URL
        let eventCount: Int
        let periodStart: Date
        let periodEndExclusive: Date
    }

    enum ExportError: LocalizedError {
        case invalidPeriod
        case futurePeriod
        case unavailableTimeZone

        var errorDescription: String? {
            switch self {
            case .invalidPeriod:
                return "7日間の開始日が正しくありません"
            case .futurePeriod:
                return "終了していない7日間は書き出せません"
            case .unavailableTimeZone:
                return "日本時間を確認できません"
            }
        }
    }

    static func japanCalendar() -> Calendar? {
        guard let timezone = TimeZone(identifier: "Asia/Tokyo") else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timezone
        return calendar
    }

    static func mostRecentCompletedStart(now: Date = Date()) -> Date {
        guard let calendar = japanCalendar() else {
            return Calendar.current.startOfDay(for: now)
        }
        let today = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: -7, to: today) ?? today
    }

    static func export(events: [VisitEvent], start: Date, now: Date = Date()) throws -> Receipt {
        guard let calendar = japanCalendar() else { throw ExportError.unavailableTimeZone }
        let periodStart = calendar.startOfDay(for: start)
        guard let periodEnd = calendar.date(byAdding: .day, value: 7, to: periodStart),
              periodEnd > periodStart else {
            throw ExportError.invalidPeriod
        }
        guard periodEnd <= calendar.startOfDay(for: now) else {
            throw ExportError.futurePeriod
        }

        let timezone = calendar.timeZone
        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "ja_JP")
        dateFormatter.timeZone = timezone
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let timeFormatter = DateFormatter()
        timeFormatter.locale = Locale(identifier: "ja_JP")
        timeFormatter.timeZone = timezone
        timeFormatter.dateFormat = "HH:mm"
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let weekdays = ["日", "月", "火", "水", "木", "金", "土"]

        // Filtering by the user-confirmed time, when available, ensures a
        // correction across midnight lands in the correct calendar day.
        let selected = events.filter { event in
            let effective = event.confirmedAt ?? event.detectedAt
            return effective >= periodStart && effective < periodEnd
        }.sorted {
            ($0.confirmedAt ?? $0.detectedAt) < ($1.confirmedAt ?? $1.detectedAt)
        }

        // Quote every CSV cell, and prefix spreadsheet formula triggers with a
        // literal apostrophe. Location names are user supplied and untrusted.
        func csvCell(_ value: String) -> String {
            let dangerous = value.range(of: #"^\s*[=+\-@]"#, options: .regularExpression) != nil
            let sanitized = dangerous ? "'" + value : value
            return "\"" + sanitized.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }

        var lines = [[
            "日付", "曜日", "開始・発生時刻", "終了時刻", "区分",
            "場所・内容", "確認状況・備考",
        ].map(csvCell).joined(separator: ",")]

        for event in selected {
            let effective = event.confirmedAt ?? event.detectedAt
            let isEntry = event.type == "entry"
            let status: String
            if let confirmed = event.confirmedAt {
                status = "本人確認時刻: \(iso.string(from: confirmed)); GPS検知: \(iso.string(from: event.detectedAt)); source=ios_geofence; event_id=\(event.id.uuidString.lowercased())"
            } else {
                status = "GPS推定時刻・本人未確認（入退店を保証しない）; GPS検知: \(iso.string(from: event.detectedAt)); source=ios_geofence; event_id=\(event.id.uuidString.lowercased())"
            }
            let weekday = weekdays[calendar.component(.weekday, from: effective) - 1]
            let row = [
                dateFormatter.string(from: effective),
                weekday,
                isEntry ? timeFormatter.string(from: effective) : "",
                isEntry ? "" : timeFormatter.string(from: effective),
                isEntry ? "到着推定（GPS）" : "退出推定（GPS）",
                event.placeName,
                status,
            ]
            lines.append(row.map(csvCell).joined(separator: ","))
        }

        let filename = "miya-gps-week-\(dateFormatter.string(from: periodStart))-\(UUID().uuidString).csv"
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        let contents = (lines.joined(separator: "\r\n") + "\r\n").data(using: .utf8)!
        try contents.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
        return Receipt(file: file, eventCount: selected.count,
                       periodStart: periodStart, periodEndExclusive: periodEnd)
    }
}
