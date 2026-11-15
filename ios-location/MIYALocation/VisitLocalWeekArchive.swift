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
        case archiveMissing
        case readbackMismatch

        var errorDescription: String? {
            switch self {
            case .invalidAnchor: return "バックアップの開始日が正しくありません"
            case .eventLimit: return "週の記録が多すぎます。手動で分割を確認してください"
            case .existingArchiveCorrupted: return "既存の週次バックアップが破損または改変されています。上書きせず保護しました"
            case .archiveMissing: return "保管済みのはずの7日分が見つかりません。保存済みと報告せず停止しました"
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

    /// Check all existing completed-week archives without modifying a single
    /// byte. This catches corruption or accidental removal *after* a previously
    /// successful write, not just the immediate readback after creation.
    static func verifyExisting(in directory: URL) throws -> Set<String> {
        let manager = FileManager.default
        guard manager.fileExists(atPath: directory.path) else { return [] }
        let names = try manager.contentsOfDirectory(atPath: directory.path)
        let encoder = encoder()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        var coveredPeriods = Set<String>()
        for name in names where name.hasPrefix("week-") && name.hasSuffix(".json") {
            let file = directory.appendingPathComponent(name)
            let bytes = try Data(contentsOf: file)
            guard bytes.count <= 5_000_000,
                  let envelope = try? decoder.decode(Envelope.self, from: bytes),
                  envelope.payload.version == 1,
                  envelope.payload.timezone == "Asia/Tokyo",
                  !envelope.payload.coverageVerified,
                  envelope.payload.events.count <= 5000 else {
                throw Failure.existingArchiveCorrupted
            }
            let hash = digest(try encoder.encode(envelope.payload))
            let expectedName = "week-\(envelope.payload.periodStart)-\(hash).json"
            guard hash == envelope.sha256, expectedName == name else {
                throw Failure.existingArchiveCorrupted
            }
            coveredPeriods.insert(envelope.payload.periodStart)
        }
        return coveredPeriods
    }

    /// A saved cursor is only a claim. Independently confirm that every
    /// completed 7-day period before it still has a valid on-disk archive.
    static func verifyCheckpoint(anchor: Date, cursor: Date,
                                 directory: URL) throws {
        guard let calendar = VisitWeekExporter.japanCalendar() else {
            throw Failure.invalidAnchor
        }
        let start = calendar.startOfDay(for: anchor)
        let end = calendar.startOfDay(for: cursor)
        guard start <= end else { throw Failure.invalidAnchor }
        let present = try verifyExisting(in: directory)
        var day = start
        var count = 0
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        while day < end {
            guard let next = calendar.date(byAdding: .day, value: 7, to: day),
                  next <= end, count < 1200 else { throw Failure.invalidAnchor }
            guard present.contains(formatter.string(from: day)) else {
                throw Failure.archiveMissing
            }
            count += 1
            day = next
        }
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
