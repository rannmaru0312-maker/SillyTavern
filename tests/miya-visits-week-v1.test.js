import { describe, expect, test } from '@jest/globals';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dateWindow, completedWeek } = require('../plugins/miya-memory/visits-week-v1.js');

const now = Date.parse('2026-11-15T00:01:00Z'); // Nov 15 in Japan
const event = (event_id, detected_at, confirmed_at = null) => ({
    event_id, place_name: 'Fictional cafe',
    kind: 'entry', detected_at, confirmed_at,
});

describe('completed Japan-local seven-day GPS export', () => {
    test('rejects unfinished weeks and calendar-invalid dates', () => {
        expect(dateWindow('2026-11-09', now)).toBeNull();
        expect(dateWindow('2026-11-08', now)?.endInclusive).toBe('2026-11-14');
        expect(dateWindow('2026-02-30', now)).toBeNull();
        expect(dateWindow('bad', now)).toBeNull();
        expect(completedWeek([], '2026-11-09', now)).toBeNull();
    });

    test('includes events between Nov 8 00:00 JST and Nov 15 00:00 JST only', () => {
        const events = [
            event('before', '2026-11-07T14:59:59Z'),
            event('first', '2026-11-07T15:00:00Z'),
            event('last', '2026-11-14T14:59:59Z'),
            event('after', '2026-11-14T15:00:00Z'),
        ];
        const result = completedWeek(events, '2026-11-08', now);
        expect(result.events.map(x => x.event_id)).toEqual(['first', 'last']);
        expect(result.events.map(x => x.date)).toEqual(['2026-11-08', '2026-11-14']);
        expect(result.events.every(x => x.time_status === 'gps_estimated')).toBe(true);
    });

    test('confirmed time moves event to correct day without inventing movement', () => {
        const events = [
            event('confirmed', '2026-11-07T14:59:00Z', '2026-11-07T15:01:00Z'),
            event('outside-after-correction', '2026-11-08T12:00:00Z', '2026-11-14T15:30:00Z'),
        ];
        const result = completedWeek(events, '2026-11-08', now);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
            event_id: 'confirmed', date: '2026-11-08',
            time: '00:01', time_status: 'user_confirmed',
        });
    });

    test('empty event list is not asserted as proof of no visits', () => {
        const result = completedWeek([], '2026-11-08', now);
        expect(result.events).toEqual([]);
        expect(result.message).toMatch(/does not prove/);
    });
});
