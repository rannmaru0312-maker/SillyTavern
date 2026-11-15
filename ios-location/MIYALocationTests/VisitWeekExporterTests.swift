import XCTest
@testable import MIYALocation

final class VisitWeekExporterTests: XCTestCase {
    private func utc(_ text: String) -> Date {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: text)!
    }

    private func event(name: String, detected: String, confirmed: String? = nil,
                       type: String = "entry") -> VisitEvent {
        VisitEvent(id: UUID(), placeID: UUID(), placeName: name, type: type,
                   detectedAt: utc(detected),
                   confirmedAt: confirmed.map { utc($0) })
    }

    func testExportsOnlyCompletedJapanLocalWeekWithoutInventingEvents() throws {
        let now = utc("2026-11-15T00:00:00Z")
        let start = utc("2026-11-07T15:00:00Z") // Nov 8, 00:00 JST
        let before = event(name: "Before", detected: "2026-11-07T14:59:59Z")
        let first = event(name: "Office", detected: "2026-11-07T15:01:00Z")
        let last = event(name: "Last day", detected: "2026-11-14T14:59:00Z")
        let after = event(name: "After", detected: "2026-11-14T15:00:00Z")
        let receipt = try VisitWeekExporter.export(events: [before, first, last, after],
                                                   start: start, now: now)
        defer { try? FileManager.default.removeItem(at: receipt.file) }
        XCTAssertEqual(receipt.eventCount, 2)
        let csv = try String(contentsOf: receipt.file, encoding: .utf8)
        XCTAssertTrue(csv.contains("Office"))
        XCTAssertTrue(csv.contains("Last day"))
        XCTAssertFalse(csv.contains("Before"))
        XCTAssertFalse(csv.contains("After"))
        XCTAssertEqual(csv.components(separatedBy: "\r\n").count, 4) // header, 2 rows, empty
        XCTAssertTrue(csv.contains("GPS推定時刻・本人未確認"))
    }

    func testConfirmedTimeDeterminesDayAndCannotBeMisrepresentedAsGPSOnly() throws {
        let start = utc("2026-11-07T15:00:00Z")
        let now = utc("2026-11-15T00:00:00Z")
        let moved = event(name: "Crossed midnight",
                          detected: "2026-11-07T14:59:00Z",
                          confirmed: "2026-11-07T15:01:00Z")
        let receipt = try VisitWeekExporter.export(events: [moved], start: start, now: now)
        defer { try? FileManager.default.removeItem(at: receipt.file) }
        XCTAssertEqual(receipt.eventCount, 1)
        let csv = try String(contentsOf: receipt.file, encoding: .utf8)
        XCTAssertTrue(csv.contains("2026-11-08"))
        XCTAssertTrue(csv.contains("本人確認時刻:"))
        XCTAssertTrue(csv.contains("00:01"))
    }

    func testRejectsUnfinishedSevenDayPeriod() throws {
        let start = utc("2026-11-10T15:00:00Z") // Nov 11 JST
        let now = utc("2026-11-15T00:00:00Z") // Nov 15 JST
        XCTAssertThrowsError(try VisitWeekExporter.export(events: [], start: start, now: now))
    }

    func testSpreadsheetFormulaInPlaceNameIsNeutralized() throws {
        let start = utc("2026-11-07T15:00:00Z")
        let now = utc("2026-11-15T00:00:00Z")
        let malicious = event(name: "=HYPERLINK(\"https://example.invalid\",\"X\")",
                              detected: "2026-11-08T12:00:00Z")
        let receipt = try VisitWeekExporter.export(events: [malicious], start: start, now: now)
        defer { try? FileManager.default.removeItem(at: receipt.file) }
        let csv = try String(contentsOf: receipt.file, encoding: .utf8)
        XCTAssertTrue(csv.contains("'=HYPERLINK"))
        XCTAssertFalse(csv.contains(",\"=HYPERLINK"))
    }
}
