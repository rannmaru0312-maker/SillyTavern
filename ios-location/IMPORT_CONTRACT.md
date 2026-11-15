# GPS visit event import contract — partial implementation

**Current state:** a disabled-by-default, session-bound JSON import/export endpoint exists at `plugins/miya-memory/visits-import-v1-api.js`. The iOS app still has **no HTTP uploader**, so no GPS data is sent over the network. No Google Drive integration is implemented.

## Consent and transport
- Future iOS synchronization must require explicit user consent; currently **no iOS sync implementation**. Server API disabled unless `MIYA_VISIT_IMPORT_ENABLED=1` and an absolute private `MIYA_VISIT_DATA_DIR` are configured.
- HTTPS, authenticated session, CSRF protection where applicable, and server-side user ID derived from auth (never client-submitted).
- Do not embed tokens in the iOS source, logs, URL, or CSV.
- No raw continuous GPS track; transmit only registered place visit events after opt-in.
- Never include real user addresses or private diary records in GitHub.

## Event schema
- event_id: random UUID created on device, immutable and unique per user.
- place_id: random UUID; place_name: user-assigned display name.
- kind: entry | exit.
- detected_at: ISO 8601 UTC timestamp, **estimated**.
- confirmed_at: optional user-confirmed timestamp; never infer it from detected_at.
- source: ios_geofence.
- schema_version: 1.

## Server rules
- Derive user identity from authenticated session; reject unauthenticated or unauthorized writes.
- Prototype validates supported event schema, UUIDs, date-time strings, payload size (32KiB), max 20 events per import and 5000 per account. **Rate limiting is not yet implemented**.
- Prototype stores separate local files per authenticated session user, with event ID deduplication and conflict rejection; this is **not** a production database uniqueness constraint and is not safe for multi-instance concurrent writes.
- Never accept user_id from request body as an authority.
- Keep GPS events separate from confirmed diary entries until user review.
- Record audit metadata without logging exact coordinates.
- Prototype provides authenticated JSON export; server deletion endpoint, retention policy and automated backup are **not yet implemented**.
- Never claim successful Google Drive backup from successful API upload alone.

## Seven-day Drive export (not implemented from GPS events)
1. Identify next consecutive seven **completed** local calendar days from last verified week.
2. Read existing Drive rows and check duplicates by source/event ID and date.
3. Preserve event source and whether timestamp is estimated/confirmed.
4. Append only missing records; read back and compare every row.
5. Notify the user of success only after exact readback; otherwise report partial write and retry safely.

## Test checklist (unit tests added; results subject to CI)
- New Jest tests cover authentication rejection, disabled-default behavior, per-user isolation, duplicate retries and invalid payloads. Simulator build verifies compilation only, not location behavior.
- Denied/WhenInUse/Always permissions and revoked permission.
- Background and terminated-app entry/exit, restart, device reboot, airplane mode.
- No event on permission denial, monitoring off, or missing place.
- Duplicate callbacks and duplicate import retry.
- Two users with the same event ID cannot read each other's data.
- No leakage in logs, crash reports, or GitHub.
- Seven-day boundary around local midnight and daylight-saving transitions.
- Drive partial write, network timeout, rate-limit, duplicate import, readback mismatch.
