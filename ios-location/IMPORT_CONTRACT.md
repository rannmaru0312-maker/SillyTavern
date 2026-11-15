# GPS visit event import contract (design only)

Status: specification, **not implemented**. No network upload is currently performed.

## Consent and transport
- User explicitly enables synchronization in the iOS app; default is off.
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
- Validate type, lengths, timestamps, UUIDs, payload size; rate-limit.
- Unique constraint (user_id, event_id); repeated import is idempotent, never duplicates.
- Never accept user_id from request body as an authority.
- Keep GPS events separate from confirmed diary entries until user review.
- Record audit metadata without logging exact coordinates.
- Allow export and deletion; document retention and backup policy.
- Never claim successful Google Drive backup from successful API upload alone.

## Seven-day Drive export
1. Identify next consecutive seven **completed** local calendar days from last verified week.
2. Read existing Drive rows and check duplicates by source/event ID and date.
3. Preserve event source and whether timestamp is estimated/confirmed.
4. Append only missing records; read back and compare every row.
5. Notify the user of success only after exact readback; otherwise report partial write and retry safely.

## Test checklist (not yet executed)
- Denied/WhenInUse/Always permissions and revoked permission.
- Background and terminated-app entry/exit, restart, device reboot, airplane mode.
- No event on permission denial, monitoring off, or missing place.
- Duplicate callbacks and duplicate import retry.
- Two users with the same event ID cannot read each other's data.
- No leakage in logs, crash reports, or GitHub.
- Seven-day boundary around local midnight and daylight-saving transitions.
- Drive partial write, network timeout, rate-limit, duplicate import, readback mismatch.
