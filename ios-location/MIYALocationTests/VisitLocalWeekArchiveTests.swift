import XCTest
@testable import MIYALocation

final class VisitLocalWeekArchiveTests: XCTestCase {
    private func utc(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    private func makeFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("miya-week-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private func exampleEvent(confirmedAt: Date? = nil, id: UUID = UUID()) -> VisitEvent {
        VisitEvent(id: id, placeID: UUID(), placeName: "Fictional shop",
                   type: "entry", detectedAt: utc("2026-11-08T01:00:00Z"),
                   confirmedAt: confirmedAt)
    }

    func testWritesAndVerifiesExactlyOneCompletedWeekWithoutDuplicating() throws {
        let folder = try makeFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let anchor = utc("2026-11-07T15:00:00Z") // Nov 8, 00:00 JST
        let now = utc("2026-11-15T01:00:00Z")
        let event = exampleEvent()
        let first = try VisitLocalWeekArchive.writeCompleted(
            events: [event], anchor: anchor, now: now, directory: folder)
        XCTAssertEqual(first.created, 1)
        XCTAssertEqual(first.alreadyVerified, 0)
        XCTAssertEqual(first.completedPeriodsChecked, 1)
        let file = try XCTUnwrap(first.lastFile)
        let saved = try Data(contentsOf: file)
        XCTAssertFalse(saved.isEmpty)
        let second = try VisitLocalWeekArchive.writeCompleted(
            events: [event], anchor: anchor, now: now, directory: folder)
        XCTAssertEqual(second.created, 0)
        XCTAssertEqual(second.alreadyVerified, 1)
        XCTAssertEqual(try Data(contentsOf: file), saved)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).count, 1)
    }

    func testTimeCorrectionRetainsPriorSnapshotAsSeparateRevision() throws {
        let folder = try makeFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let anchor = utc("2026-11-07T15:00:00Z")
        let now = utc("2026-11-15T01:00:00Z")
        let old = exampleEvent()
        let oldReceipt = try VisitLocalWeekArchive.writeCompleted(
            events: [old], anchor: anchor, now: now, directory: folder)
        let oldFile = try XCTUnwrap(oldReceipt.lastFile)
        var revised = old
        revised.confirmedAt = utc("2026-11-08T01:05:00Z")
        let correction = try VisitLocalWeekArchive.writeCompleted(
            events: [revised], anchor: anchor, now: now, directory: folder)
        XCTAssertEqual(correction.created, 1)
        XCTAssertNotEqual(correction.lastFile, oldFile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: oldFile.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).count, 2)
    }

    func testTamperedExistingSnapshotFailsClosedWithoutOverwriting() throws {
        let folder = try makeFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let anchor = utc("2026-11-07T15:00:00Z")
        let now = utc("2026-11-15T01:00:00Z")
        let visits = [exampleEvent()]
        let original = try VisitLocalWeekArchive.writeCompleted(
            events: visits, anchor: anchor, now: now, directory: folder)
        let file = try XCTUnwrap(original.lastFile)
        let changed = Data("damaged content".utf8)
        try changed.write(to: file)
        XCTAssertThrowsError(try VisitLocalWeekArchive.writeCompleted(
            events: visits, anchor: anchor, now: now, directory: folder))
        XCTAssertEqual(try Data(contentsOf: file), changed)
    }

    func testAnEmptyWeekDoesNotClaimCompleteGPSCoverage() throws {
        let folder = try makeFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let result = try VisitLocalWeekArchive.writeCompleted(
            events: [], anchor: utc("2026-11-07T15:00:00Z"),
            now: utc("2026-11-15T01:00:00Z"), directory: folder)
        let bytes = try Data(contentsOf: XCTUnwrap(result.lastFile))
        let payload = try JSONDecoder().decode(VisitLocalWeekArchive.Envelope.self, from: bytes)
        XCTAssertFalse(payload.payload.coverageVerified)
        XCTAssertTrue(payload.payload.events.isEmpty)
        XCTAssertEqual(payload.payload.periodStart, "2026-11-08")
        XCTAssertEqual(payload.payload.periodEndInclusive, "2026-11-14")
    }

    func testTwentyFourWeekBatchCanResumeFromVerifiedCheckpoint() throws {
        let folder = try makeFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let anchor = utc("2026-01-01T15:00:00Z") // Jan 2 in Japan
        let now = utc("2026-02-20T15:00:00Z") // 7 completed periods
        let first = try VisitLocalWeekArchive.writeCompleted(
            events: [], anchor: anchor, now: now, directory: folder, maxPeriods: 2)
        XCTAssertEqual(first.created, 2)
        XCTAssertTrue(first.hasMoreCompletedPeriods)
        let second = try VisitLocalWeekArchive.writeCompleted(
            events: [], anchor: first.nextPeriodStart, now: now,
            directory: folder, maxPeriods: 2)
        XCTAssertEqual(second.created, 2)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).count, 4)
        // Repeating a completed batch must read and verify, not create duplicates.
        let repeated = try VisitLocalWeekArchive.writeCompleted(
            events: [], anchor: anchor, now: now, directory: folder, maxPeriods: 2)
        XCTAssertEqual(repeated.created, 0)
        XCTAssertEqual(repeated.alreadyVerified, 2)
    }

    func testUnfinishedWeekIsNotArchived() throws {
        let folder = try makeFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let result = try VisitLocalWeekArchive.writeCompleted(
            events: [], anchor: utc("2026-11-14T15:00:00Z"),
            now: utc("2026-11-15T01:00:00Z"), directory: folder)
        XCTAssertEqual(result.created, 0)
        XCTAssertNil(result.lastFile)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).count, 0)
    }
}
