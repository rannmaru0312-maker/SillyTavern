import Foundation

/// A portable, user-initiated event archive. Never includes exact GPS coordinates,
/// account credentials, passwords, or continuous location tracking.
enum VisitArchive {
    struct Document: Codable {
        let schemaVersion: Int
        let createdAt: Date
        let events: [VisitEvent]
    }

    enum ArchiveError: LocalizedError {
        case tooLarge
        case unsupported
        case invalid
        case conflict

        var errorDescription: String? {
            switch self {
            case .tooLarge: return "バックアップが大きすぎます（上限5MB・5000件）"
            case .unsupported: return "バックアップのバージョンに対応していません"
            case .invalid: return "バックアップ内の記録が不正です"
            case .conflict: return "同じ記録IDで内容の異なるデータがあるため復元を中止しました"
            }
        }
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }

    private static func check(_ events: [VisitEvent]) throws {
        guard events.count <= 5000 else { throw ArchiveError.tooLarge }
        let ids = Set(events.map(\.id))
        guard ids.count == events.count else { throw ArchiveError.invalid }
        for event in events {
            guard ["entry", "exit"].contains(event.type),
                  !event.placeName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  event.placeName.count <= 100,
                  event.detectedAt.timeIntervalSince1970.isFinite,
                  (946_684_800...4_102_444_800).contains(event.detectedAt.timeIntervalSince1970),
                  event.confirmedAt.map {
                      $0.timeIntervalSince1970.isFinite &&
                      (946_684_800...4_102_444_800).contains($0.timeIntervalSince1970)
                  } ?? true else {
                throw ArchiveError.invalid
            }
        }
    }

    static func create(_ events: [VisitEvent]) throws -> Data {
        try check(events)
        let document = Document(schemaVersion: 1, createdAt: Date(), events: events)
        let data = try encoder().encode(document)
        guard data.count <= 5_000_000 else { throw ArchiveError.tooLarge }
        return data
    }

    private static func sameMillisecond(_ a: Date, _ b: Date) -> Bool {
        Int64((a.timeIntervalSince1970 * 1000).rounded()) ==
        Int64((b.timeIntervalSince1970 * 1000).rounded())
    }

    /// Never changes an event's identity or GPS detection timestamp.
    /// A stale backup may not erase a user-confirmed timestamp.
    /// Conflicting confirmed corrections require manual reconciliation instead.
    static func merge(current: [VisitEvent], archive: Data) throws -> [VisitEvent] {
        guard archive.count <= 5_000_000 else { throw ArchiveError.tooLarge }
        let document: Document
        do {
            document = try decoder().decode(Document.self, from: archive)
        } catch { throw ArchiveError.invalid }
        guard document.schemaVersion == 1 else { throw ArchiveError.unsupported }
        try check(current)
        try check(document.events)
        var byID = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
        guard current.count + document.events.count <= 10_000 else {
            throw ArchiveError.tooLarge
        }
        for event in document.events {
            if let previous = byID[event.id] {
                guard previous.placeID == event.placeID,
                      previous.placeName == event.placeName,
                      previous.type == event.type,
                      sameMillisecond(previous.detectedAt, event.detectedAt) else {
                    throw ArchiveError.conflict
                }
                if let oldConfirmed = previous.confirmedAt,
                   let newConfirmed = event.confirmedAt, !sameMillisecond(oldConfirmed, newConfirmed) {
                    throw ArchiveError.conflict
                }
                // Prefer a confirmed time over a stale unconfirmed copy.
                if previous.confirmedAt == nil && event.confirmedAt != nil {
                    byID[event.id] = event
                }
            } else {
                byID[event.id] = event
            }
        }
        guard byID.count <= 5000 else { throw ArchiveError.tooLarge }
        return byID.values.sorted {
            if $0.detectedAt == $1.detectedAt {
                return $0.id.uuidString < $1.id.uuidString
            }
            return $0.detectedAt < $1.detectedAt
        }
    }
}
