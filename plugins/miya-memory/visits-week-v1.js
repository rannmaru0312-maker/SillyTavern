// Pure, side-effect-free grouping of GPS events for a completed seven-day
// calendar period in Japan. No guessed movements or times.
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ymd = /^\d{4}-\d{2}-\d{2}$/;

function dateWindow(startDay, now = Date.now()) {
    if (typeof startDay !== 'string' || !ymd.test(startDay)) return null;
    const start = Date.parse(startDay + 'T00:00:00+09:00');
    if (!Number.isFinite(start) ||
        new Date(start + JST_OFFSET_MS).toISOString().slice(0, 10) !== startDay) return null;
    const todayJST = new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);
    const startOfToday = Date.parse(todayJST + 'T00:00:00+09:00');
    const end = start + 7 * DAY_MS;
    if (!(end <= startOfToday)) return null; // do not include today or future days
    return {
        startEpoch: start,
        endEpoch: end,
        start: startDay,
        endInclusive: new Date(end - DAY_MS + JST_OFFSET_MS).toISOString().slice(0, 10),
    };
}

function completedWeek(events, startDay, now = Date.now()) {
    const week = dateWindow(startDay, now);
    if (!week || !Array.isArray(events)) return null;
    const items = events.flatMap(event => {
        const effective = event.confirmed_at ?? event.detected_at;
        const timestamp = Date.parse(effective);
        if (!Number.isFinite(timestamp) ||
            timestamp < week.startEpoch || timestamp >= week.endEpoch) return [];
        const japanLocal = new Date(timestamp + JST_OFFSET_MS).toISOString();
        return [{
            event_id: event.event_id,
            place_name: event.place_name,
            kind: event.kind,
            date: japanLocal.slice(0, 10),
            time: japanLocal.slice(11, 16),
            detected_at: event.detected_at,
            confirmed_at: event.confirmed_at,
            time_status: event.confirmed_at ? 'user_confirmed' : 'gps_estimated',
            source: 'ios_geofence',
        }];
    }).sort((a, b) => (
        (Date.parse(a.confirmed_at ?? a.detected_at) - Date.parse(b.confirmed_at ?? b.detected_at)) ||
        a.event_id.localeCompare(b.event_id)
    ));
    return {
        period_start: week.start,
        period_end_inclusive: week.endInclusive,
        timezone: 'Asia/Tokyo',
        source: 'ios_geofence',
        message: 'No detected events does not prove that no visit took place.',
        events: items,
    };
}

module.exports = { dateWindow, completedWeek };
