import Foundation
import Combine

/// Best-effort copying to a user-selected directory available in iOS Files,
/// including third-party File Providers if installed. A provider readback does
/// NOT prove remote Google Drive cloud upload, durability, or correct Drive ACLs.
@MainActor final class VisitArchiveFolderSync: ObservableObject {
    @Published private(set) var isEnabled: Bool
    @Published private(set) var hasSelectedFolder: Bool
    @Published private(set) var isBusy = false
    @Published private(set) var status = "外部フォルダーへの自動コピーは停止しています"

    private let bookmarkKey = "miya-files-provider-weekly-bookmark-v1"
    private let enabledKey = "miya-files-provider-weekly-enabled-v1"
    private var activeCopy: Task<Result<VisitArchiveFileMirror.Receipt, Error>, Never>?
    private var requestGeneration = 0

    init() {
        let defaults = UserDefaults.standard
        isEnabled = defaults.bool(forKey: enabledKey)
        hasSelectedFolder = defaults.data(forKey: bookmarkKey) != nil
        if isEnabled && !hasSelectedFolder {
            isEnabled = false
            defaults.set(false, forKey: enabledKey)
        }
    }

    /// Only an interactive iOS document picker may grant this directory scope.
    /// Store the bookmark, never a naked external filesystem path.
    func selectFolder(_ url: URL) {
        guard url.isFileURL, url.startAccessingSecurityScopedResource() else {
            status = "選んだフォルダーへのアクセスを取得できません。ファイルアプリから選び直してください"
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }
        do {
            let bookmark = try url.bookmarkData(options: [],
                                                includingResourceValuesForKeys: nil,
                                                relativeTo: nil)
            guard !bookmark.isEmpty else {
                status = "フォルダーへのアクセスを保存できませんでした"
                return
            }
            disable()
            UserDefaults.standard.set(bookmark, forKey: bookmarkKey)
            hasSelectedFolder = true
            status = "保存先を登録しました。コピーを有効にするまでは送信しません"
        } catch {
            status = "フォルダーの登録に失敗しました。ファイルアプリから選び直してください"
        }
    }

    func enable() {
        guard hasSelectedFolder else {
            status = "まず保存先のフォルダーを選んでください"
            return
        }
        isEnabled = true
        UserDefaults.standard.set(true, forKey: enabledKey)
        status = "次のアプリ起動・復帰時にファイルアプリ側へコピーを試みます"
    }

    func disable() {
        // Stop pending work at the next file boundary and suppress stale UI
        // success if a networked File Provider finishes after consent revocation.
        requestGeneration += 1
        activeCopy?.cancel()
        activeCopy = nil
        isBusy = false
        isEnabled = false
        UserDefaults.standard.set(false, forKey: enabledKey)
        status = "外部フォルダーへの自動コピーを停止しました。既存のコピーは残ります"
    }

    func forgetFolder() {
        disable()
        UserDefaults.standard.removeObject(forKey: bookmarkKey)
        hasSelectedFolder = false
        status = "保存先へのアクセス設定を破棄しました（保存済みファイルは削除しません）"
    }

    /// App-open/resume best effort only. File Provider I/O must NOT block the
    /// SwiftUI main actor while a networked provider is unavailable or slow.
    func copyIfEnabled(from localArchives: URL) {
        guard isEnabled, !isBusy else { return }
        guard let bookmark = UserDefaults.standard.data(forKey: bookmarkKey) else {
            disable()
            status = "保存先の登録がありません。コピーを停止しました"
            return
        }
        isBusy = true
        requestGeneration += 1
        let generation = requestGeneration

        let operation = Task.detached(priority: .utility) {
            () -> Result<VisitArchiveFileMirror.Receipt, Error> in
            do {
                try Task<Never, Never>.checkCancellation()
                var stale = false
                let folder = try URL(resolvingBookmarkData: bookmark, options: [],
                                     relativeTo: nil, bookmarkDataIsStale: &stale)
                guard !stale, folder.isFileURL,
                      folder.startAccessingSecurityScopedResource() else {
                    throw FolderSyncError.scopeUnavailable
                }
                defer { folder.stopAccessingSecurityScopedResource() }
                let receipt = try VisitArchiveFileMirror.copyVerifiedArchives(
                    from: localArchives, to: folder,
                    shouldCancel: { Task<Never, Never>.isCancelled }
                )
                try Task<Never, Never>.checkCancellation()
                return .success(receipt)
            } catch {
                return .failure(error)
            }
        }
        activeCopy = operation
        Task { @MainActor [weak self] in
            let result = await operation.value
            guard let self, self.requestGeneration == generation else {
                // The user disabled sharing or selected a different folder.
                // No stale result is allowed to announce copy success.
                return
            }
            self.activeCopy = nil
            self.isBusy = false
            guard self.isEnabled else { return }
            switch result {
            case .success(let receipt):
                let remaining = receipt.moreFilesRemain ?
                    "残りのファイルがあります。再試行が必要です。" : ""
                self.status = "ファイルアプリ経由：新規" + String(receipt.copied) +
                    "件、コピー照合済み" + String(receipt.existingVerified) + "件。" +
                    remaining + " Driveクラウド上の保存確認はまだ完了していません。"
            case .failure(let error):
                if error is CancellationError {
                    self.status = "コピーは途中で停止しました。再開時に未完了分を検証します"
                } else {
                    self.status = "外部フォルダーへのコピー・読み戻し照合に失敗しました：" +
                        error.localizedDescription
                }
            }
        }
    }

    private enum FolderSyncError: LocalizedError {
        case scopeUnavailable

        var errorDescription: String? {
            "保存先への権限が失われました。ファイルアプリから選び直してください"
        }
    }
}
