# MIYA Location — iPhone geofence & manual sync prototype (Draft PR #29)

## Verified so far
- iOS Simulator unsigned builds passed for earlier commits (most recent prior known success: a20180f). See PR checks for the **latest HEAD** result; a passing build is not an iPhone field test.
- The iOS Simulator build, Jest and ESLint checks have passed on PR commit fbcb3c3 (confirmed 2026-11-15). See GitHub checks for the current HEAD; passing CI is not an iPhone field test.

## Features in source code
- SwiftUI interface to register a location by explicit coordinates or current location, start/stop monitoring, and inspect geofence entry/exit events.
- Local event storage, user confirmation marker, CSV export, and device-side deletion.
- User-initiated JSON event archive export/import for portability. Re-import merges by stable event ID, refuses conflicting identities and cannot erase a confirmed timestamp with an older unconfirmed copy. **The archive does not include exact geofence coordinates**, so locations must be registered again after a clean installation.
- Japan-time **7 completed calendar-day CSV** with the existing diary's seven columns, immutable event IDs for duplicate checking, explicit GPS-estimated vs user-confirmed times, and spreadsheet-formula injection protection. A blank week exports only a header; no visits are invented.
- **Opt-in automatic device-only weekly snapshots**: checks on app launch/resume and after record changes, creates immutable SHA-256-named 7-day snapshots, re-reads each saved file byte-for-byte, preserves prior revisions after corrections, and advances a checkpoint only after verification. The user can manually share the latest verified snapshot to Google Drive via the iOS share sheet; automatic Drive upload is **not** implemented.
- If an existing local diary file becomes unreadable, the recorder blocks accidental overwriting instead of starting with an apparently empty diary. An explicit restore or erase is required. A user-confirmed delete-all also deletes app-local weekly archives, but cannot remove previously shared external copies.
- Optional **manual** upload: enter the correct MIYA server HTTPS URL and existing account username/password, sign in using SillyTavern's login and CSRF middleware, explicitly grant upload consent, and press the send button.
- The client verifies GET /api/users/me before accepting the session and does not persist the password, cookies or credentials to disk. It blocks HTTP redirects, prohibits plaintext HTTP and does not embed service credentials.
- Sends user-named place + timestamps + event IDs, **never exact coordinates or location tracks**. After POST batches (20 max), GET export and compare every uploaded record before saying server sync succeeded.
- Prototype import API is **disabled by default**, with session-based user separation, file-level locking to prevent concurrent lost updates, event ID deduplication, JSON export and an explicit authenticated delete-all API. The client checks readback after import or deletion.
- Authenticated `/api/plugins/miya-memory/visits/week-v1?start=YYYY-MM-DD` previews GPS events for a completed seven-day Japan-time window, without claiming Drive persistence. Unit and isolated HTTP tests cover dates, ownership, and empty weeks. To enable it in a **dedicated test environment only**, set MIYA_VISIT_IMPORT_ENABLED=1 and MIYA_VISIT_DATA_DIR to a private absolute directory; server plugins must already be enabled and restarted. Do not switch these on in production without tests.

## Significant limitations
- Upload happens only while app is open and the user presses the button. **No background upload**, automatic account login or unattended seven-day Google Drive sync has been implemented. Weekly snapshots are **device-local only** and created best-effort when the app runs or is resumed: iOS does **not** guarantee an exact 7-day execution time, and uninstalling/losing the phone can destroy them unless the user exports a copy. CSV/JSON creation is **not** confirmation of a Google Drive backup.
- Server stores events in private local JSON files, which may be **ephemeral on cloud hosts**, not durable across deployment or scalable to multiple hosts. Render workspace inspection on 2026-11-15 found no existing Render Postgres instance and the running app is on the free plan: **do not enable GPS event uploads to this instance or claim permanent persistence**. There is no production database, retention policy, audit trail, or complete rate limiting. Delete-all requires user login, explicit confirmation, and server readback.
- Login uses the existing session/cookie authentication. An isolated HTTP test with cookie-session and csrf-sync has been added, but full real HTTP integration with the actual SillyTavern server is still required.
- A confirmed_at change after an earlier upload is now supported for the same authenticated user and event ID. The immutable event identity (event ID, place and detected time) cannot change; conflicting metadata still returns HTTP 409. Confirmation edits need real-device and HTTP round-trip tests.
- A geofence callback is not evidence of an actual building entrance. The estimated time must remain visibly distinct from user-confirmed time.
- Local event files use iOS file protection until first device unlock after reboot to allow locked-screen geofence callback writes; this does not guarantee delivery while the device is powered off or before first unlock.
- iPhone installation/signing and background location behavior are **not tested**. A Mac/Xcode or a compatible signed build and Apple's authorization requirements are needed before actual device use.
- iOS source has not been merged into MIYA & KOHARU production. Keep the PR Draft until review.
- Never put real home/work coordinates, passwords or live user data into GitHub or CI.


## Background snapshot check (best effort, NOT Drive sync)
- The app now registers a `BGAppRefreshTask` with an explicit Info.plist identifier and enables iOS `fetch` background mode. The XcodeGen workflow checks both settings.
- **Only when the user enables device-local weekly archives**, the app asks iOS for a future background opportunity. Disabling archives cancels that request.
- At the system's discretion, a wake can refresh local archive files and verify them. A schedule request is not proof the system actually ran it. Force quitting, battery conditions, OS policies, and permission settings can suppress it.
- The app additionally checks on launch/resume and after event corrections. Archive verification is a separate operation from real building-entry detection.
- No background GPS uploads, Google Drive write, or guaranteed exactly-seven-day delivery have been implemented. Apple Developer signing and physical iPhone validation are still needed.
- A private Google Drive intake folder can accept a weekly CSV/JSON **manually shared** by the user. A connected cloud automation can then attempt validation and import, but no intake path has yet been verified end to end. Never report Drive backup success without checking rows from Drive after the write.


## Macなし・追加費用なしで先に使う方法
- 専用SwiftUIアプリの実機インストールにはMac/Xcodeでの署名が必要。ユーザーは現時点でMacを持っていないので、**個人利用MVPの実用経路としてiPhone標準ショートカットの「到着」「出発」オートメーションを優先**する。
- 設定手順は `ios-location/NO_MAC_SHORTCUTS_MVP.md`。iPhoneのメモに場所名・GPS推定時刻を保存する。ショートカットの実行・メモへの記録はまだ実機未検証であり、到着/退出は店舗への実際の入退店を保証しない。
- `tools/miya-parse-shortcuts-visits.mjs` と `tests/miya-shortcuts-visits.test.js` に、メモの4列書式を解析するオフライン検証器と合成テストを追加。イベントIDは内容から導出した再現可能な照合キーであり、別個の訪問や本人確認を保証しない。
- **メモの保存はGoogle Driveへの自動保存ではない。** 既存の7日分生活記録と統合する前に、本人の明示共有・重複確認・Google Driveの再読取が必要。
- Apple公式：<https://support.apple.com/ja-jp/guide/shortcuts/apd8ebfc4e8e/ios> / <https://support.apple.com/ja-jp/guide/shortcuts/apd602971e63/ios>

## Next steps
1. Verify latest iOS build, Jest, ESLint, seven-day export XCTest, and new local weekly snapshot/restore tests on the exact PR HEAD; fix any failures.
2. Test real HTTP login / CSRF / cookie lifecycle, denied access and logout with isolated accounts.
3. Design persistent authenticated storage, rate limiting, conflict-safe edits and delete/export.
4. Test on a signed iPhone, foreground/background/restart, permission revocation and battery impact.
5. Add opt-in unattended upload only after secure persistent device credentials and privacy review.
6. Link server events to **durable** seven-day Drive export with OAuth/permissions, idempotent event IDs, verified readback and success-only notifications. A local weekly CSV is a manual fallback, not automatic sync.

This is a development prototype, **not a ready-to-install iPhone app**.
