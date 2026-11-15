/**
 * Offline verifier for manually exported MIYA iOS GPS weeks.
 * Usage: node tools/miya-validate-gps-week.mjs /path/to/week-YYYY-MM-DD-SHA256.json
 * It does NOT write to Drive and never treats a GPS hit as proven building entry.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const JST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
    throw new Error('Invalid GPS week archive: ' + message);
}

function sortDeep(value) {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortDeep(value[key])]));
    }
    return value;
}

function startOfJapanDay(dateString) {
    if (typeof dateString !== 'string' || !YMD.test(dateString)) fail('invalid period start');
    const start = Date.parse(dateString + 'T00:00:00+09:00');
    if (!Number.isFinite(start) ||
        new Date(start + JST_MS).toISOString().slice(0, 10) !== dateString) {
        fail('nonexistent period start date');
    }
    return start;
}

function japanStamp(milliseconds) {
    return new Date(milliseconds + JST_MS).toISOString();
}

function safeLabel(value) {
    // Sheet writes must use stringValue, never userEnteredValue.formulaValue.
    return /^\s*[=+\-@]/.test(value) ? "'" + value : value;
}

/**
 * Verify exact bytes, schema, event identity and seven complete Japan-local days.
 * No network requests or external writes occur here.
 */
export function validateGPSWeek(source, options = {}) {
    const raw = Buffer.isBuffer(source) ? source : Buffer.from(source);
    if (!raw.length || raw.length > 12_000_000) fail('file size');
    let archive;
    try { archive = JSON.parse(raw.toString('utf8')); }
    catch { fail('JSON parsing failed'); }
    if (!archive || typeof archive !== 'object' || Array.isArray(archive) ||
        !SHA.test(archive.sha256 || '') ||
        typeof archive.canonicalPayloadBase64 !== 'string' ||
        !archive.canonicalPayloadBase64.length) {
        fail('missing canonical bytes or checksum');
    }
    const encoded = archive.canonicalPayloadBase64;
    const canonical = Buffer.from(encoded, 'base64');
    if (canonical.length < 2 || canonical.length > 5_000_000 ||
        canonical.toString('base64') !== encoded) fail('non-canonical base64');
    const hash = createHash('sha256').update(canonical).digest('hex');
    if (hash !== archive.sha256) fail('SHA-256 mismatch');
    let payload;
    try { payload = JSON.parse(canonical.toString('utf8')); }
    catch { fail('embedded payload JSON'); }
    if (JSON.stringify(sortDeep(payload)) !== JSON.stringify(sortDeep(archive.payload))) {
        fail('payload differs from verified bytes');
    }
    if (!payload || payload.version !== 1 || payload.timezone !== 'Asia/Tokyo' ||
        payload.coverageVerified !== false || !Array.isArray(payload.events) ||
        payload.events.length > 5000) fail('invalid payload schema');
    const start = startOfJapanDay(payload.periodStart);
    const end = start + 7 * DAY_MS;
    const expectedEnd = new Date(end - DAY_MS + JST_MS).toISOString().slice(0, 10);
    if (payload.periodEndInclusive !== expectedEnd) fail('period end mismatch');
    const now = options.now instanceof Date ? options.now.getTime() : Date.now();
    const todayJST = japanStamp(now).slice(0, 10);
    if (end > startOfJapanDay(todayJST)) fail('seven-day window is incomplete');
    const filename = 'week-' + payload.periodStart + '-' + hash + '.json';
    if (options.fileName && basename(options.fileName) !== filename) fail('filename mismatch');

    const ids = new Set();
    const rows = [];
    for (const event of payload.events) {
        if (!event || typeof event !== 'object' || Array.isArray(event) ||
            !UUID.test(event.id || '') || !UUID.test(event.placeID || '') ||
            typeof event.placeName !== 'string' || !event.placeName.trim() ||
            event.placeName.length > 100 || !['entry', 'exit'].includes(event.type) ||
            typeof event.detectedAt !== 'number' || !Number.isFinite(event.detectedAt) ||
            (event.confirmedAt != null &&
                (typeof event.confirmedAt !== 'number' || !Number.isFinite(event.confirmedAt)))) {
            fail('invalid event');
        }
        const id = event.id.toLowerCase();
        if (ids.has(id)) fail('duplicate event ID');
        ids.add(id);
        const effective = event.confirmedAt ?? event.detectedAt;
        if (effective < start || effective >= end) fail('event outside week');
        if (event.detectedAt < 946_684_800_000 || event.detectedAt > 4_102_444_800_000 ||
            (event.confirmedAt != null &&
             (event.confirmedAt < 946_684_800_000 || event.confirmedAt > 4_102_444_800_000))) {
            fail('date outside supported range');
        }
        const local = japanStamp(effective);
        const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(effective + JST_MS).getUTCDay()];
        rows.push({
            eventId: id,
            date: local.slice(0, 10),
            weekday,
            start: event.type === 'entry' ? local.slice(11, 16) : '',
            end: event.type === 'exit' ? local.slice(11, 16) : '',
            category: event.type === 'entry' ? '到着推定（GPS）' : '退出推定（GPS）',
            location: safeLabel(event.placeName),
            notes: (event.confirmedAt != null ?
                '本人確認時刻: ' + new Date(event.confirmedAt).toISOString() :
                'GPS推定・本人未確認') +
                '; GPS検知: ' + new Date(event.detectedAt).toISOString() +
                '; source=ios_geofence; event_id=' + id,
            confirmed: event.confirmedAt != null,
        });
    }
    rows.sort((a, b) => (a.date + a.start + a.end).localeCompare(b.date + b.start + b.end) ||
        a.eventId.localeCompare(b.eventId));
    return { periodStart: payload.periodStart, periodEndInclusive: expectedEnd,
        verifiedSha256: hash, eventCount: rows.length, coverageVerified: false, rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 3) {
        process.stderr.write('Usage: node tools/miya-validate-gps-week.mjs <file.json>\n');
        process.exitCode = 2;
    } else {
        try {
            const filename = resolve(process.argv[2]);
            const result = validateGPSWeek(await readFile(filename), { fileName: filename });
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } catch (error) {
            process.stderr.write(error.message + '\n');
            process.exitCode = 1;
        }
    }
}
