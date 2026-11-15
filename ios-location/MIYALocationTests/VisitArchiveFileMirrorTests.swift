import XCTest
@testable import MIYALocation

final class VisitArchiveFileMirrorTests: XCTestCase {
    private func utc(_ text: String) -> Date {
        ISO8601DateFormatter().date(from: text)!
    }

    private func directory() throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("miya-external-mirror-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private func event() -> VisitEvent {
        VisitEvent(id: UUID(), placeID: UUID(), placeName: "Fictional café",
                   type: "entry", detectedAt: utc("2026-11-08T01:00:00Z"),
                   confirmedAt: nil)
    }

    func testCopyAndReadbackAreIdempotent() throws {
        let local = try directory()
        let target = try directory()
        defer {
            try? FileManager.default.removeItem(at: local)
            try? FileManager.default.removeItem(at: target)
        }
        _ = try VisitLocalWeekArchive.writeCompleted(
            events: [event()], anchor: utc("2026-11-07T15:00:00Z"),
            now: utc("2026-11-15T01:00:00Z"), directory: local)
        let first = try VisitArchiveFileMirror.copyVerifiedArchives(from: local, to: target)
        XCTAssertEqual(first.copied, 1)
        XCTAssertEqual(first.existingVerified, 0)
        XCTAssertFalse(first.moreFilesRemain)
        let again = try VisitArchiveFileMirror.copyVerifiedArchives(from: local, to: target)
        XCTAssertEqual(again.copied, 0)
        XCTAssertEqual(again.existingVerified, 1)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path).count, 1)
    }

    func testConflictingTargetFileIsNeverOverwritten() throws {
        let local = try directory()
        let target = try directory()
        defer {
            try? FileManager.default.removeItem(at: local)
            try? FileManager.default.removeItem(at: target)
        }
        let receipt = try VisitLocalWeekArchive.writeCompleted(
            events: [event()], anchor: utc("2026-11-07T15:00:00Z"),
            now: utc("2026-11-15T01:00:00Z"), directory: local)
        let filename = try XCTUnwrap(receipt.lastFile).lastPathComponent
        let targetFile = target.appendingPathComponent(filename)
        let changed = Data("another owner's file".utf8)
        try changed.write(to: targetFile)
        XCTAssertThrowsError(try VisitArchiveFileMirror.copyVerifiedArchives(from: local, to: target))
        XCTAssertEqual(try Data(contentsOf: targetFile), changed)
    }

    func testMissingLocalArchiveDoesNotClaimAnyCopy() throws {
        let local = try directory()
        let target = try directory()
        defer {
            try? FileManager.default.removeItem(at: local)
            try? FileManager.default.removeItem(at: target)
        }
        let result = try VisitArchiveFileMirror.copyVerifiedArchives(from: local, to: target)
        XCTAssertEqual(result.copied, 0)
        XCTAssertEqual(result.existingVerified, 0)
        XCTAssertEqual(result.filesInspected, 0)
    }

    func testBatchLimitAllowsIncrementalProgressPastPreviouslyCopiedFiles() throws {
        let local = try directory()
        let target = try directory()
        defer {
            try? FileManager.default.removeItem(at: local)
            try? FileManager.default.removeItem(at: target)
        }
        _ = try VisitLocalWeekArchive.writeCompleted(
            events: [], anchor: utc("2026-10-03T15:00:00Z"),
            now: utc("2026-11-15T01:00:00Z"), directory: local)
        let all = try FileManager.default.contentsOfDirectory(atPath: local.path).count
        XCTAssertGreaterThan(all, 2)
        let one = try VisitArchiveFileMirror.copyVerifiedArchives(from: local, to: target, maxFiles: 1)
        XCTAssertEqual(one.copied, 1)
        XCTAssertTrue(one.moreFilesRemain)
        let two = try VisitArchiveFileMirror.copyVerifiedArchives(from: local, to: target, maxFiles: 1)
        XCTAssertEqual(two.copied, 1)
        XCTAssertGreaterThanOrEqual(two.existingVerified, 1)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path).count, 2)
    }

    func testRevokedConsentStopsAtNextFileBoundaryAndCanResume() throws {
        let local = try directory()
        let target = try directory()
        defer {
            try? FileManager.default.removeItem(at: local)
            try? FileManager.default.removeItem(at: target)
        }
        _ = try VisitLocalWeekArchive.writeCompleted(
            events: [], anchor: utc("2026-10-03T15:00:00Z"),
            now: utc("2026-11-15T01:00:00Z"), directory: local)
        var visits = 0
        XCTAssertThrowsError(try VisitArchiveFileMirror.copyVerifiedArchives(
            from: local, to: target, shouldCancel: {
                visits += 1
                return visits > 1
            }
        )) { error in
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path).count, 1)
        let resumed = try VisitArchiveFileMirror.copyVerifiedArchives(
            from: local, to: target, maxFiles: 24)
        XCTAssertGreaterThan(resumed.copied, 0)
        XCTAssertGreaterThan(resumed.existingVerified, 0)
        XCTAssertFalse(resumed.moreFilesRemain)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: target.path).count,
            try FileManager.default.contentsOfDirectory(atPath: local.path).count
        )
    }

    func testTamperedLocalArchiveIsRejectedBeforeExport() throws {
        let local = try directory()
        let target = try directory()
        defer {
            try? FileManager.default.removeItem(at: local)
            try? FileManager.default.removeItem(at: target)
        }
        let receipt = try VisitLocalWeekArchive.writeCompleted(
            events: [event()], anchor: utc("2026-11-07T15:00:00Z"),
            now: utc("2026-11-15T01:00:00Z"), directory: local)
        let file = try XCTUnwrap(receipt.lastFile)
        try Data("broken data".utf8).write(to: file, options: .atomic)
        XCTAssertThrowsError(try VisitArchiveFileMirror.copyVerifiedArchives(from: local, to: target))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: target.path).isEmpty)
    }
}
