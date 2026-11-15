import XCTest
@testable import MIYALocation

final class VisitArchiveTests: XCTestCase {
    private func stamp(_ text: String) -> Date {
        ISO8601DateFormatter().date(from: text)!
    }

    private func event(id: UUID = UUID(), placeID: UUID = UUID(),
                       name: String = "Fictional cafe", confirmed: Date? = nil) -> VisitEvent {
        VisitEvent(id: id, placeID: placeID, placeName: name,
                   type: "entry", detectedAt: stamp("2026-11-15T01:00:00Z"),
                   confirmedAt: confirmed)
    }

    func testArchiveIsPortableAndDoesNotDuplicateEventsOnRestore() throws {
        let original = event()
        let json = try VisitArchive.create([original])
        let string = String(data: json, encoding: .utf8)!
        XCTAssertTrue(string.contains("Fictional cafe"))
        XCTAssertFalse(string.contains("\"latitude\""))
        XCTAssertFalse(string.contains("\"longitude\""))
        let restored = try VisitArchive.merge(current: [original], archive: json)
        XCTAssertEqual(restored.count, 1)
        XCTAssertEqual(restored[0].id, original.id)
    }

    func testArchivedConfirmationCanUpgradePreviouslyUnconfirmedRecord() throws {
        let original = event()
        let confirmed = event(id: original.id, placeID: original.placeID,
                              confirmed: stamp("2026-11-15T01:03:00Z"))
        let backup = try VisitArchive.create([confirmed])
        let result = try VisitArchive.merge(current: [original], archive: backup)
        XCTAssertEqual(result.count, 1)
        XCTAssertNotNil(result[0].confirmedAt)
        XCTAssertEqual(result[0].confirmedAt!, confirmed.confirmedAt!)
    }

    func testStaleArchiveCannotEraseUserConfirmedTime() throws {
        let old = event()
        let confirmed = event(id: old.id, placeID: old.placeID,
                              confirmed: stamp("2026-11-15T01:03:00Z"))
        let result = try VisitArchive.merge(current: [confirmed], archive: VisitArchive.create([old]))
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].confirmedAt, confirmed.confirmedAt)
    }

    func testConflictingEventIdentityIsRejectedWithoutMutation() throws {
        let old = event()
        let conflicting = event(id: old.id, placeID: old.placeID, name: "Another place")
        XCTAssertThrowsError(try VisitArchive.merge(current: [old], archive: VisitArchive.create([conflicting])))
        XCTAssertEqual(old.placeName, "Fictional cafe")
    }

    func testMalformedJsonAndDuplicateIdsAreRejected() throws {
        XCTAssertThrowsError(try VisitArchive.merge(current: [], archive: Data("not json".utf8)))
        let first = event()
        XCTAssertThrowsError(try VisitArchive.create([first, first]))
    }
}
