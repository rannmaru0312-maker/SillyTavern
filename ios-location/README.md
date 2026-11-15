# MIYA Location iOS integration (draft)
iPhone geofence visit logging prototype, isolated from existing SillyTavern runtime.
Privacy: no embedded real-world home/work coordinates, no automatic network transmission.
Do not merge or enable without signed iPhone testing and data-protection review.

## Current status
- XcodeGen project configuration and GitHub Actions unsigned iOS Simulator build workflow are staged in this branch.
- SwiftUI/ CoreLocation source files from the local v0.5 prototype must be integrated before CI can build successfully.
- GitHub Actions workflow has not been run. No signed IPA, iPhone installation, server import API, or Google Drive sync.
- A macOS runner may consume paid minutes; verify available quotas before manual workflow dispatch.
- Existing user/character memory and authentication are untouched.

## Required next steps
1. Add the verified v0.5 Swift source files under ios-location/MIYALocation.
2. Run iOS Simulator build and fix compile errors.
3. Test geofence callbacks, permission revocation, app restart, timestamp correction, local export.
4. Design opt-in authenticated import with per-user isolation and idempotent event IDs.
5. Verify seven-day Google Drive save with read-back before notifying the user.
