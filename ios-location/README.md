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

## Next steps
1. Verify latest iOS build, Jest, ESLint, seven-day export XCTest, and new local weekly snapshot/restore tests on the exact PR HEAD; fix any failures.
2. Test real HTTP login / CSRF / cookie lifecycle, denied access and logout with isolated accounts.
3. Design persistent authenticated storage, rate limiting, conflict-safe edits and delete/export.
4. Test on a signed iPhone, foreground/background/restart, permission revocation and battery impact.
5. Add opt-in unattended upload only after secure persistent device credentials and privacy review.
6. Link server events to **durable** seven-day Drive export with OAuth/permissions, idempotent event IDs, verified readback and success-only notifications. A local weekly CSV is a manual fallback, not automatic sync.

This is a development prototype, **not a ready-to-install iPhone app**.
