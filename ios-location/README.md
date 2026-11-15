# MIYA Location — iOS geofence prototype (Draft PR #29)

## Implemented in this branch
- SwiftUI app with place registration (manual coordinates or current location), local JSON persistence, event list and explicit CSV export
- CoreLocation circular region monitoring with Always permission requirement, stop/delete controls, event deduplication, user confirmation marker
- XcodeGen iOS project and unsigned iOS Simulator build workflow
- No hard-coded home/work coordinates; no background uploads or external services; location remains on-device

## Not yet verified / not complete
- GitHub Actions iOS build has **not run or passed**. Check macOS runner billing/quota before starting.
- iPhone installation requires Apple code signing and physical-device testing; not available from Windows alone.
- Arrival/departure notifications are approximate and may be delayed or missed; no guarantee of indoor entrance detection.
- Google Drive seven-day export and authenticated MIYA & KOHARU backend import **not implemented**. CSV export requires user action.
- No end-to-end tests, background permission tests, or iOS device tests have passed.
- Existing app, production systems, auth, and memory are untouched. Keep this PR Draft until verified.

## Before production
1. Run XcodeGen + Xcode build on macOS (only with confirmed free CI quota).
2. Fix compile failures; test foreground/background location permission and revocation.
3. Add deterministic tests for duplicate events, region-limit, data persistence, and privacy.
4. Implement opt-in authenticated import with user isolation, event idempotency, and audit trail.
5. Integrate verified weekly Google Drive write/readback, error retry, and success-only notification.
6. Test on real iPhone with the owner's consent; review battery and privacy settings.

No credentials, real addresses, or private diary contents should enter this repository.
