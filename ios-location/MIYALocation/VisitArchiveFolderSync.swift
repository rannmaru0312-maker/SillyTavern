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
            UserDefaults.standard.set(bookmark, forKey: bookmarkKey)
            hasSelectedFolder = true
            isEnabled = false
            UserDefaults.standard.set(false, forKey: enabledKey)
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

    /// App-open/resume best effort only. No unattended or exact-time guarantee.
    /// No location coordinates, session cookies or passwords are transmitted.
    func copyIfEnabled(from localArchives: URL) {
        guard isEnabled, !isBusy else { return }
        guard let bookmark = UserDefaults.standard.data(forKey: bookmarkKey) else {
            disable()
            status = "保存先の登録がありません。コピーを停止しました"
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            var stale = false
            let folder = try URL(resolvingBookmarkData: bookmark, options: [],
                                 relativeTo: nil, bookmarkDataIsStale: &stale)
            guard !stale, folder.isFileURL, folder.startAccessingSecurityScopedResource() else {
                status = "保存先への権限が失われました。ファイルアプリから選び直してください"
                return
            }
            defer { folder.stopAccessingSecurityScopedResource() }
            let receipt = try VisitArchiveFileMirror.copyVerifiedArchives(
                from: localArchives, to: folder
            )
            let suffix = receipt.moreFilesRemain ? "残りのファイルがあります。再試行が必要です。" : ""
            status = "ファイルアプリ経由：新規" + String(receipt.copied) +
                "件、コピー照合済み" + String(receipt.existingVerified) + "件。" +
                suffix + " Driveクラウド上の保存確認はまだ完了していません。"
        } catch {
            status = "外部フォルダーへのコピー・読み戻し照合に失敗しました：" +
                error.localizedDescription
        }
    }
}
