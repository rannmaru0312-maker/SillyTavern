import { createHash } from 'node:crypto';
import { describe, expect, test } from '@jest/globals';
import { validateGPSWeek } from '../tools/miya-validate-gps-week.mjs';

const event = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    placeID: '123e4567-e89b-42d3-a456-426614174001',
    placeName: 'Fictional café',
    type: 'entry',
    detectedAt: Date.parse('2026-11-08T01:00:00Z'),
    confirmedAt: null,
};
const dateNow = new Date('2026-11-16T02:00:00Z');

function sorted(v) {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v).sort().map(x => [x, sorted(v[x])]));
    }
    return v;
}
function makeArchive({ changes = {}, events = [event], name } = {}) {
    const payload = sorted({
        version: 1,
        periodStart: '2026-11-08',
        periodEndInclusive: '2026-11-14',
        timezone: 'Asia/Tokyo',
        coverageVerified: false,
        events: events.map(value => ({ ...value })),
        ...changes,
    });
    const canonical = Buffer.from(JSON.stringify(payload));
    const sha256 = createHash('sha256').update(canonical).digest('hex');
    return {
        fileName: name || 'week-2026-11-08-' + sha256 + '.json',
        archive: { sha256, canonicalPayloadBase64: canonical.toString('base64'), payload },
    };
}
function verify(x, options = {}) {
    return validateGPSWeek(Buffer.from(JSON.stringify(x.archive)), {
        fileName: x.fileName,
        now: dateNow,
        ...options,
    });
}
describe('GPS weekly Drive intake archive validation', () => {
    test('accepts exact verified payload and preserves estimated status', () => {
        const out = verify(makeArchive());
        expect(out.eventCount).toBe(1);
        expect(out.periodEndInclusive).toBe('2026-11-14');
        expect(out.coverageVerified).toBe(false);
        expect(out.rows[0]).toMatchObject({
            eventId: event.id,
            date: '2026-11-08',
            weekday: '日',
            start: '10:00',
            category: '到着推定（GPS）',
            location: 'Fictional café',
            confirmed: false,
        });
    });
    test('accepts user confirmation on different local calendar date', () => {
        const output = verify(makeArchive({ events: [{
            ...event,
            detectedAt: Date.parse('2026-11-07T14:59:00Z'),
            confirmedAt: Date.parse('2026-11-07T15:01:00Z'),
        }] }));
        expect(output.rows[0].date).toBe('2026-11-08');
        expect(output.rows[0].start).toBe('00:01');
        expect(output.rows[0].confirmed).toBe(true);
    });
    test('rejects tampered outer payload even if SHA matches embedded bytes', () => {
        const x = makeArchive();
        x.archive.payload.events[0].placeName = 'Tampered';
        expect(() => verify(x)).toThrow(/payload differs/);
    });
    test('rejects tampered embedded bytes', () => {
        const x = makeArchive();
        x.archive.canonicalPayloadBase64 = Buffer.from('{"events":[]}').toString('base64');
        expect(() => verify(x)).toThrow(/SHA-256 mismatch/);
    });
    test('rejects invalid filename, duplicate ID, fake date and unfinished weeks', () => {
        const x = makeArchive();
        x.fileName = 'week-2026-11-08-fake.json';
        expect(() => verify(x)).toThrow(/filename mismatch/);
        const dupe = makeArchive({ events: [event, { ...event }] });
        expect(() => verify(dupe)).toThrow(/duplicate event ID/);
        const nonexistent = makeArchive({ changes: { periodStart: '2026-02-30' } });
        expect(() => verify(nonexistent)).toThrow(/nonexistent period start/);
        const future = makeArchive({ changes: {
            periodStart: '2026-11-15', periodEndInclusive: '2026-11-21',
        } });
        expect(() => verify(future)).toThrow(/incomplete/);
    });
    test('rejects an event outside the declared week', () => {
        const x = makeArchive({ events: [{ ...event, detectedAt: Date.parse('2026-11-15T00:00:00Z') }] });
        expect(() => verify(x)).toThrow(/outside week/);
    });
    test('does not assert visits on empty week', () => {
        const out = verify(makeArchive({ events: [] }));
        expect(out.rows).toHaveLength(0);
        expect(out.coverageVerified).toBe(false);
    });
    test('neutralizes user-supplied spreadsheet formulas', () => {
        const x = makeArchive({ events: [{ ...event, placeName: '=HYPERLINK("https://bad.invalid","x")' }] });
        expect(verify(x).rows[0].location.startsWith("'=")).toBe(true);
    });
    test('rejects old archives with no portable canonical bytes for cloud intake', () => {
        const x = makeArchive();
        delete x.archive.canonicalPayloadBase64;
        expect(() => verify(x)).toThrow(/missing canonical/);
    });
});
