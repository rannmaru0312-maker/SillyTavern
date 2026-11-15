import { createHash } from 'node:crypto';
import { describe, expect, test } from '@jest/globals';
import { planGPSWeekMerge } from '../tools/miya-plan-gps-week-merge.mjs';

const original = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    placeID: '123e4567-e89b-42d3-a456-426614174001',
    placeName: 'Fictional cafe',
    type: 'entry',
    detectedAt: Date.parse('2026-11-08T01:00:00Z'),
    confirmedAt: null,
};
const now = new Date('2026-11-16T03:00:00Z');
const sort = value => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
    }
    return value;
};
function archive(event = original) {
    const payload = sort({
        version: 1,
        periodStart: '2026-11-08',
        periodEndInclusive: '2026-11-14',
        timezone: 'Asia/Tokyo',
        coverageVerified: false,
        events: [event],
    });
    const bytes = Buffer.from(JSON.stringify(payload));
    const hash = createHash('sha256').update(bytes).digest('hex');
    return {
        bytes: Buffer.from(JSON.stringify({
            sha256: hash,
            canonicalPayloadBase64: bytes.toString('base64'),
            payload,
        })),
        fileName: 'week-2026-11-08-' + hash + '.json',
        now,
    };
}
function plan(existing = [], event = original) {
    const x = archive(event);
    return planGPSWeekMerge(x.bytes, existing, x);
}

describe('MIYA GPS sheet write preflight (read-only)', () => {
    test('new verified GPS event becomes one append only, never writes to Drive', () => {
        const result = plan([]);
        expect(result.appends).toHaveLength(1);
        expect(result.updates).toHaveLength(0);
        expect(result.conflicts).toHaveLength(0);
        expect(result.appends[0].row).toEqual([
            '2026-11-08', '日', '10:00', '',
            '到着推定（GPS）', 'Fictional cafe',
            expect.stringContaining('source=ios_geofence; event_id='),
        ]);
        expect(result.googleDriveWritePerformed).toBe(false);
        expect(result.googleDriveReadbackVerified).toBe(false);
    });

    test('identical retry is skipped, not appended', () => {
        const row = plan().appends[0].row;
        const repeated = plan([row]);
        expect(repeated.appends).toHaveLength(0);
        expect(repeated.updates).toHaveLength(0);
        expect(repeated.skip).toEqual([{ eventId: original.id, reason: 'already-imported' }]);
    });

    test('newly confirmed time can update only matching unconfirmed GPS event', () => {
        const old = plan().appends[0].row;
        const newEvent = { ...original, confirmedAt: Date.parse('2026-11-08T01:07:00Z') };
        const result = plan([old], newEvent);
        expect(result.appends).toHaveLength(0);
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0].rowNumber).toBe(2);
        expect(result.updates[0].after[2]).toBe('10:07');
        expect(result.updates[0].after[6]).toContain('本人確認時刻: 2026-11-08T01:07:00.000Z');
    });

    test('old unconfirmed retry cannot erase confirmed time', () => {
        const confirmed = { ...original, confirmedAt: Date.parse('2026-11-08T01:07:00Z') };
        const saved = plan([], confirmed).appends[0].row;
        const retry = plan([saved], original);
        expect(retry.updates).toHaveLength(0);
        expect(retry.skip).toHaveLength(1);
        expect(retry.skip[0].reason).toBe('stale-unconfirmed-do-not-overwrite');
    });

    test('same event ID but changed place, confirmed correction or duplicate sheet rows is held', () => {
        const old = plan().appends[0].row;
        const changedPlace = { ...original, placeName: 'A different place' };
        const mismatch = plan([old], changedPlace);
        expect(mismatch.conflicts[0].reason).toBe('same-event-ID-different-content');
        const a = { ...original, confirmedAt: Date.parse('2026-11-08T01:07:00Z') };
        const b = { ...original, confirmedAt: Date.parse('2026-11-08T01:13:00Z') };
        expect(plan([plan([], a).appends[0].row], b).conflicts[0].reason)
            .toBe('same-event-ID-different-content');
        expect(plan([old, old]).conflicts[0]).toMatchObject({
            reason: 'duplicate-existing-event-ID', rows: [2, 3],
        });
    });

    test('possible duplicate human diary entry triggers review instead of append', () => {
        const manual = [
            '2026-11-08', '日', '10:05', '',
            '仕事', 'Fictional cafe', '本人の手入力',
        ];
        const result = plan([manual]);
        expect(result.appends).toHaveLength(0);
        expect(result.conflicts[0]).toMatchObject({
            reason: 'possible-manual-visit-duplicate', rows: [2],
        });
        expect(result.mayWriteWithoutHumanReview).toBe(false);
    });

    test('rejects invalid raw archive, missing file identity and impossible existing sheet shape', () => {
        const x = archive();
        expect(() => planGPSWeekMerge(Buffer.from('{}'), [], x)).toThrow();
        expect(() => planGPSWeekMerge(x.bytes, [], { now })).toThrow(/file name/);
        expect(() => planGPSWeekMerge(x.bytes, [['too', 'many', 'columns', 1, 2, 3, 4, 5]], x))
            .toThrow(/existing sheet row/);
        expect(() => planGPSWeekMerge(x.bytes, [], { ...x, firstDataRowNumber: 1 }))
            .toThrow(/first data row/);
    });

    test('neutralizes location formulas before any append proposal', () => {
        const row = plan([], { ...original, placeName: '=HYPERLINK("https://example.invalid","x")' })
            .appends[0].row;
        expect(row[5]).toMatch(/^'=HYPERLINK/);
    });
});
