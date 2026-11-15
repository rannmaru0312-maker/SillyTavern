/**
 * No-Mac shortcut diary text parser. Offline only: no network or cloud writes.
 * Input lines (one per event):
 * YYYY-MM-DD HH:mm | place label | 到着推定/退出推定 | GPS推定・本人未確認
 *
 * CLI: node tools/miya-parse-shortcuts-visits.mjs my-note.txt [YYYY-MM-DD]
 * Optional second parameter includes only a fully completed seven-day period,
 * using Japan local dates, without inventing missing events.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s*\|\s*([^|\r\n]{1,100}?)\s*\|\s*(到着推定|退出推定)\s*\|\s*(GPS推定・本人未確認)\s*$/;
const JST_OFFSET = 9 * 60 * 60 * 1000;
const DAY = 86400000;

function invalid(reason) {
    throw new Error('Invalid iPhone Shortcuts visit note: ' + reason);
}

function parseJapanTime(day, clock) {
    const timestamp = Date.parse(day + 'T' + clock + ':00+09:00');
    if (!Number.isFinite(timestamp) ||
        new Date(timestamp + JST_OFFSET).toISOString().slice(0, 16).replace('T', ' ') !== day + ' ' + clock) {
        invalid('invalid calendar date/time');
    }
    return timestamp;
}
function safeSheetValue(value) {
    return /^\s*[=+\-@]/.test(value) ? "'" + value : value;
}

/** Pure parser, never silently skips a nonempty malformed record. */
export function parseShortcutsVisits(text, { now = new Date(), weekStart = null } = {}) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 500000) invalid('size limit');
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) invalid('invalid now');
    const events = [];
    const unique = new Map();
    const possibleDuplicates = [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (const [offset, raw] of lines.entries()) {
        const line = raw.trim();
        if (!line) continue;
        const match = line.match(LINE);
        if (!match) invalid('unrecognized record on line ' + (offset + 1));
        const [, day, clock, rawPlace, kind, status] = match;
        const place = rawPlace.trim();
        if (!place || place.length > 100) invalid('invalid place on line ' + (offset + 1));
        const at = parseJapanTime(day, clock);
        if (at > now.getTime() + DAY) invalid('unreasonable future time on line ' + (offset + 1));
        const normalized = day + ' ' + clock + '|' + place + '|' + kind;
        // This is a reproducible import key, NOT a random UUID or proof of a
        // distinct location callback. Repeated identical lines need review.
        const eventId = createHash('sha256').update('miya-shortcuts-v1:' + normalized).digest('hex');
        const previous = unique.get(eventId);
        if (previous) {
            possibleDuplicates.push({ firstLine: previous.lineNumber, anotherLine: offset + 1, eventId });
        } else {
            unique.set(eventId, { lineNumber: offset + 1 });
        }
        events.push({
            eventId,
            lineNumber: offset + 1,
            date: day,
            time: clock,
            place: safeSheetValue(place),
            kind,
            status,
            detectedAt: new Date(at).toISOString(),
            source: 'ios_shortcuts_arrival_departure',
            confirmedAt: null,
        });
    }
    if (events.length > 5000) invalid('more than 5000 events');
    let filtered = events;
    let periodEndInclusive = null;
    if (weekStart !== null) {
        if (typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) invalid('week start');
        const start = parseJapanTime(weekStart, '00:00');
        const end = start + 7 * DAY;
        const nowJSTDay = new Date(now.getTime() + JST_OFFSET).toISOString().slice(0, 10);
        if (end > parseJapanTime(nowJSTDay, '00:00')) invalid('week not complete');
        filtered = events.filter(x => {
            const at = Date.parse(x.detectedAt);
            return at >= start && at < end;
        });
        periodEndInclusive = new Date(end - DAY + JST_OFFSET).toISOString().slice(0, 10);
    }
    return {
        source: 'ios_shortcuts_arrival_departure',
        timezone: 'Asia/Tokyo',
        estimatedOnly: true,
        coverageVerified: false,
        weekStart,
        periodEndInclusive,
        count: filtered.length,
        hasPossibleDuplicateCallbacks: possibleDuplicates.length > 0,
        possibleDuplicates,
        events: filtered,
        googleDriveWritePerformed: false,
        googleDriveReadbackVerified: false,
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length < 3 || process.argv.length > 4) {
        process.stderr.write('Usage: node tools/miya-parse-shortcuts-visits.mjs note.txt [YYYY-MM-DD]\n');
        process.exitCode = 2;
    } else {
        try {
            const input = await readFile(resolve(process.argv[2]), 'utf8');
            process.stdout.write(JSON.stringify(parseShortcutsVisits(input, {
                weekStart: process.argv[3] || null,
            }), null, 2) + '\n');
        } catch (error) {
            process.stderr.write(error.message + '\n');
            process.exitCode = 1;
        }
    }
}
