import Foundation
import CryptoKit

/// Device-only, content-addressed backups of completed Japan-local 7-day periods.
/// These archives are not Google Drive backups. A saved archive must be read back
/// and byte-verified before it is reported as successfully written.
enum VisitLocalWeekArchive {
    struct WeekContent: Codable {
        let version: Int
        let periodStart: String
        let periodEndInclusive: String
        let timezone: String
        let events: [VisitEvent]
        let coverageVerified: Bool
    }

    struct Envelope: Codable {
        let sha256: String
        let payload: WeekContent
    }

    struct Report {
        let created: Int
        let alreadyVerified: Int
        let completedPeriodsChecked: Int
        let hasMoreCompletedPeriods: Bool
        let lastPeriodStart: String?
        let lastFile: URL?
        let nextPeriodStart: Date
    }

    enum Failure: LocalizedError {
        case invalidAnchor
        case eventLimit
        case existingArchiveCorrupted
        case readbackMismatch

        var errorDescription: String? {
            switch self {
            case .invalidAnchor: return "バックアップの開始日が正しくありません"
            case .eventLimit: return "週の記録が多すぎます。手動で分割を確認してください"
            case .existingArchiveCorrupted: return "既存の週次バックアップが読めないため上書きせず中止しました"
            case .readbackMismatch: return "ローカル保存後の再読込照合に失敗しました"
            }
        }
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func dayString(_ date: Date, timezone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timezone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// If no GPS events were observed in a week, the file contains 0 events
    /// but explicitly says coverage was NOT verified. It never invents visits.
    static func writeCompleted(
        events: [VisitEvent],
        anchor: Date,
        now: Date = Date(),
        directory: URL,
        maxPeriods: Int = 24
    ) throws -> Report {
        guard let calendar = VisitWeekExporter.japanCalendar(),
              maxPeriods > 0, maxPeriods <= 100 else {
            throw Failure.invalidAnchor
        }
        let start = calendar.startOfDay(for: anchor)
        let today = calendar.startOfDay(for: now)
        guard start <= today else { throw Failure.invalidAnchor }
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
        var cursor = start
        var created = 0
        var alreadyVerified = 0
        var checked = 0
        var lastPeriod: String?
        var lastFile: URL?
        let encoder = encoder()

        while checked < maxPeriods {
            guard let end = calendar.date(byAdding: .day, value: 7, to: cursor),
                  end <= today else { break }
            let periodStart = dayString(cursor, timezone: calendar.timeZone)
            guard let inclusiveEnd = calendar.date(byAdding: .day, value: -1, to: end) else {
                throw Failure.invalidAnchor
            }
            let orderedEvents = events.filter { event in
                let time = event.confirmedAt ?? event.detectedAt
                return time >= cursor && time < end
            }.sorted {
                let lhs = $0.confirmedAt ?? $0.detectedAt
                let rhs = $1.confirmedAt ?? $1.detectedAt
                return lhs == rhs ? $0.id.uuidString < $1.id.uuidString : lhs < rhs
            }
            guard orderedEvents.count <= 5000 else { throw Failure.eventLimit }
            let content = WeekContent(
                version: 1,
                periodStart: periodStart,
                periodEndInclusive: dayString(inclusiveEnd, timezone: calendar.timeZone),
                timezone: "Asia/Tokyo",
                events: orderedEvents,
                coverageVerified: false
            )
            let canonical = try encoder.encode(content)
            let hash = digest(canonical)
            let envelope = Envelope(sha256: hash, payload: content)
            let bytes = try encoder.encode(envelope)
            let file = directory.appendingPathComponent("week-\(periodStart)-\(hash).json")

            if manager.fileExists(atPath: file.path) {
                // Never overwrite a damaged or modified backup. User action is
                // required to resolve differences, and old revisions are retained.
                guard try Data(contentsOf: file) == bytes else {
                    throw Failure.existingArchiveCorrupted
                }
                alreadyVerified += 1
            } else {
                try bytes.write(to: file, options: [
                    .atomic, .completeFileProtectionUntilFirstUserAuthentication,
                ])
                guard try Data(contentsOf: file) == bytes else {
                    throw Failure.readbackMismatch
                }
                created += 1
            }
            checked += 1
            lastPeriod = periodStart
            lastFile = file
            cursor = end
        }

        let hasMore = (calendar.date(byAdding: .day, value: 7, to: cursor) ?? .distantFuture) <= today
        return Report(
            created: created,
            alreadyVerified: alreadyVerified,
            completedPeriodsChecked: checked,
            hasMoreCompletedPeriods: hasMore,
            lastPeriodStart: lastPeriod,
            lastFile: lastFile,
            nextPeriodStart: cursor
        )
    }
}
