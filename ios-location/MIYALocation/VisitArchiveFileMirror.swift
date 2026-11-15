import Foundation

/// Copies already-verified app-local weekly archives to a directory explicitly
/// chosen with the iOS document picker. It verifies File Provider readback, NOT
/// a completed Google Drive cloud upload.
enum VisitArchiveFileMirror {
    struct Receipt {
        let copied: Int
        let existingVerified: Int
        let filesInspected: Int
        let moreFilesRemain: Bool
    }

    enum Failure: LocalizedError {
        case invalidDirectory
        case conflictingExistingCopy
        case readbackMismatch
        case coordinatedReadFailed
        case coordinatedWriteFailed

        var errorDescription: String? {
            switch self {
            case .invalidDirectory:
                return "指定された保存先がフォルダーではありません"
            case .conflictingExistingCopy:
                return "保存先に同じ名前で内容の異なるファイルがあります。上書きせず停止しました"
            case .readbackMismatch:
                return "コピー後のファイルを読み戻しても一致しませんでした"
            case .coordinatedReadFailed:
                return "外部フォルダーからファイルを読み戻せません"
            case .coordinatedWriteFailed:
                return "外部フォルダーへの書き込みに失敗しました"
            }
        }
    }

    private static func readCoordinated(_ file: URL) throws -> Data {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var readError: Error?
        var result: Data?
        coordinator.coordinate(readingItemAt: file, options: [], error: &coordinationError) { readableURL in
            do { result = try Data(contentsOf: readableURL) }
            catch { readError = error }
        }
        if let coordinationError { throw coordinationError }
        if let readError { throw readError }
        guard let result else { throw Failure.coordinatedReadFailed }
        return result
    }

    private static func writeCoordinated(_ data: Data, filename: String, in folder: URL) throws {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var writeError: Error?
        coordinator.coordinate(writingItemAt: folder, options: .forMerging,
                               error: &coordinationError) { writableFolder in
            let target = writableFolder.appendingPathComponent(filename)
            do {
                if FileManager.default.fileExists(atPath: target.path) {
                    // Never overwrite a file just because its name matches.
                    let existing = try Data(contentsOf: target)
                    guard existing == data else { throw Failure.conflictingExistingCopy }
                } else {
                    try data.write(to: target, options: .atomic)
                }
            } catch { writeError = error }
        }
        if let coordinationError { throw coordinationError }
        if let writeError { throw writeError }
    }

    /// This is strictly an external File Provider copy; it cannot confirm
    /// server-side Google Drive durability, owner or folder permissions.
    static func copyVerifiedArchives(from source: URL, to destination: URL,
                                     maxFiles: Int = 24) throws -> Receipt {
        guard maxFiles > 0 && maxFiles <= 100,
              destination.isFileURL else { throw Failure.invalidDirectory }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: destination.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { throw Failure.invalidDirectory }

        // Fail closed if any local archive is damaged before allowing export.
        _ = try VisitLocalWeekArchive.verifyExisting(in: source)
        guard FileManager.default.fileExists(atPath: source.path) else {
            return Receipt(copied: 0, existingVerified: 0,
                           filesInspected: 0, moreFilesRemain: false)
        }

        let all = try FileManager.default.contentsOfDirectory(atPath: source.path)
            .filter { $0.hasPrefix("week-") && $0.hasSuffix(".json") }
            .sorted()
        let selected = all.prefix(maxFiles)
        var copied = 0
        var already = 0
        for name in selected {
            let src = source.appendingPathComponent(name)
            let dst = destination.appendingPathComponent(name)
            let data = try Data(contentsOf: src)
            let existed = FileManager.default.fileExists(atPath: dst.path)
            if existed {
                guard try readCoordinated(dst) == data else {
                    throw Failure.conflictingExistingCopy
                }
                already += 1
                continue
            }
            try writeCoordinated(data, filename: name, in: destination)
            guard try readCoordinated(dst) == data else {
                throw Failure.readbackMismatch
            }
            copied += 1
        }

        return Receipt(
            copied: copied, existingVerified: already,
            filesInspected: selected.count,
            moreFilesRemain: all.count > selected.count
        )
    }
}
