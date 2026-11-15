/**
 * Read-only plan for importing one verified GPS week into an existing 7-column
 * life-log sheet. Never fetches, edits, or shares Google Drive content.
 * Caller MUST reread the sheet immediately before applying an approved plan,
 * then verify every written cell by rereading it afterwards.
 */
import { validateGPSWeek } from './miya-validate-gps-week.mjs';

const ID_PATTERN = /(?:^|[;\s])event_id=([0-9a-f-]{36})(?:$|[;\s])/i;
const GPS_SOURCE = /(?:^|[;\s])source=ios_geofence(?:$|[;\s])/;
const DETECTED = /GPS検知:\s*([^;\s]+)/;
const SHEET_COLS = 7;

function stringCell(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).trim();
}

function normalizedPlace(value) {
    return stringCell(value).normalize('NFKC').replace(/\s+/g, '').replace(/^'/, '');
}

function extractID(note) {
    const match = stringCell(note).match(ID_PATTERN);
    return match ? match[1].toLowerCase() : null;
}

function minutes(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [h, m] = value.split(':').map(Number);
    if (h > 23 || m > 59) return null;
    return 60 * h + m;
}

function looksLikeSameVisit(existing, incoming) {
    if (stringCell(existing[0]) !== incoming[0]) return false;
    if (normalizedPlace(existing[5]) !== normalizedPlace(incoming[5])) return false;
    const arrival = incoming[2] !== '';
    const observed = minutes(arrival ? incoming[2] : incoming[3]);
    const previous = minutes(arrival ? stringCell(existing[2]) : stringCell(existing[3]));
    if (observed === null || previous === null) {
        // Date + place match, but incomplete timing: request human review.
        return true;
    }
    return Math.abs(observed - previous) <= 30;
}

function asSheetRow(item) {
    return [
        item.date, item.weekday, item.start, item.end,
        item.category, item.location, item.notes,
    ];
}

function equalsRow(a, b) {
    return a.length === b.length &&
        a.every((v, i) => stringCell(v) === stringCell(b[i]));
}

function safeConfirmedUpdate(existing, incoming) {
    if (!GPS_SOURCE.test(stringCell(existing[6])) ||
        !stringCell(existing[6]).startsWith('GPS推定・本人未確認') ||
        !stringCell(incoming[6]).startsWith('本人確認時刻:')) return false;
    // Nothing but the previously unconfirmed time/notes may change.
    const sameLocation = stringCell(existing[5]) === stringCell(incoming[5]);
    const sameKind = stringCell(existing[4]) === stringCell(incoming[4]);
    const oldGPS = stringCell(existing[6]).match(DETECTED)?.[1];
    const newGPS = stringCell(incoming[6]).match(DETECTED)?.[1];
    return sameLocation && sameKind && !!oldGPS && oldGPS === newGPS &&
        stringCell(existing[0]) !== '' && !!extractID(existing[6]);
}

/**
 * @param {Uint8Array|Buffer|string} archiveBytes - raw signed-ish content
 * @param {unknown[]} existingRows - unchanged A2:Gn cell values (one row per sheet row)
 * @param {{fileName:string,now?:Date,firstDataRowNumber?:number}} options
 * @returns {object} a dry-run plan: appends, updates, skip, conflicts, verifiedHash
 */
export function planGPSWeekMerge(archiveBytes, existingRows, options = {}) {
    if (!Array.isArray(existingRows) || existingRows.length > 100000) {
        throw new TypeError('Expected at most 100000 existing sheet rows');
    }
    if (!Number.isInteger(options.firstDataRowNumber ?? 2) ||
        (options.firstDataRowNumber ?? 2) < 2) throw new TypeError('Invalid first data row');
    // The verifier is mandatory, not optional. Filename and date are checked.
    if (typeof options.fileName !== 'string' || !options.fileName) {
        throw new TypeError('Verified file name is required');
    }
    const parsed = validateGPSWeek(archiveBytes, options);
    const byId = new Map();
    const normalizedExisting = existingRows.map((row, idx) => {
        if (!Array.isArray(row) || row.length > SHEET_COLS) {
            throw new TypeError('Invalid existing sheet row at ' + idx);
        }
        const cells = Array.from({ length: SHEET_COLS }, (_, i) => stringCell(row[i]));
        const id = extractID(cells[6]);
        if (id) {
            const list = byId.get(id) || [];
            list.push({ rowNumber: idx + (options.firstDataRowNumber ?? 2), cells });
            byId.set(id, list);
        }
        return cells;
    });
    const appends = [];
    const updates = [];
    const skip = [];
    const conflicts = [];
    for (const observed of parsed.rows) {
        const incoming = asSheetRow(observed);
        const matches = byId.get(observed.eventId) || [];
        if (matches.length > 1) {
            conflicts.push({ eventId: observed.eventId, reason: 'duplicate-existing-event-ID',
                rows: matches.map(m => m.rowNumber) });
            continue;
        }
        if (matches.length === 1) {
            const current = matches[0];
            if (equalsRow(current.cells, incoming)) {
                skip.push({ eventId: observed.eventId, reason: 'already-imported' });
            } else if (!observed.confirmed &&
                       stringCell(current.cells[6]).startsWith('本人確認時刻:') &&
                       normalizedPlace(current.cells[5]) === normalizedPlace(incoming[5])) {
                skip.push({ eventId: observed.eventId, reason: 'stale-unconfirmed-do-not-overwrite' });
            } else if (observed.confirmed && safeConfirmedUpdate(current.cells, incoming)) {
                updates.push({ eventId: observed.eventId, rowNumber: current.rowNumber,
                    before: current.cells, after: incoming, reason: 'first-user-confirmation' });
            } else {
                conflicts.push({ eventId: observed.eventId, reason: 'same-event-ID-different-content',
                    rows: [current.rowNumber] });
            }
            continue;
        }
        const maybeDuplicate = normalizedExisting.findIndex(row =>
            extractID(row[6]) === null && looksLikeSameVisit(row, incoming));
        if (maybeDuplicate >= 0) {
            conflicts.push({ eventId: observed.eventId, reason: 'possible-manual-visit-duplicate',
                rows: [maybeDuplicate + (options.firstDataRowNumber ?? 2)] });
            continue;
        }
        appends.push({ eventId: observed.eventId, row: incoming });
    }
    return {
        periodStart: parsed.periodStart,
        periodEndInclusive: parsed.periodEndInclusive,
        verifiedHash: parsed.verifiedSha256,
        inspectedExistingRows: existingRows.length,
        eventCount: parsed.eventCount,
        coverageVerified: false,
        appends, updates, skip, conflicts,
        mayWriteWithoutHumanReview: conflicts.length === 0,
        googleDriveWritePerformed: false,
        googleDriveReadbackVerified: false,
    };
}
