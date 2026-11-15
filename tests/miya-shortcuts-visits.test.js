import { describe, expect, test } from '@jest/globals';
import { parseShortcutsVisits } from '../tools/miya-parse-shortcuts-visits.mjs';

const now = new Date('2026-11-16T00:00:00Z');
const sample = [
    '2026-11-08 10:00 | テスト地点A | 到着推定 | GPS推定・本人未確認',
    '2026-11-08 10:15 | テスト地点A | 退出推定 | GPS推定・本人未確認',
].join('\n');

describe('Mac-free iPhone Shortcuts visit note parser', () => {
    test('parses Japanese local times and preserves estimated-only nature', () => {
        const result = parseShortcutsVisits(sample, { now, weekStart: '2026-11-08' });
        expect(result.count).toBe(2);
        expect(result.coverageVerified).toBe(false);
        expect(result.googleDriveWritePerformed).toBe(false);
        expect(result.googleDriveReadbackVerified).toBe(false);
        expect(result.events[0]).toMatchObject({
            date: '2026-11-08', time: '10:00', place: 'テスト地点A',
            kind: '到着推定', status: 'GPS推定・本人未確認',
            detectedAt: '2026-11-08T01:00:00.000Z', confirmedAt: null,
        });
        expect(result.periodEndInclusive).toBe('2026-11-14');
    });

    test('retry uses same deterministic ID and flags duplicate callbacks', () => {
        const first = parseShortcutsVisits(sample, { now });
        const second = parseShortcutsVisits(sample, { now });
        expect(first.events[0].eventId).toBe(second.events[0].eventId);
        const dup = parseShortcutsVisits(sample + '\n' + sample.split('\n')[0], { now });
        expect(dup.count).toBe(3);
        expect(dup.possibleDuplicates).toHaveLength(1);
        expect(dup.possibleDuplicates[0]).toMatchObject({ firstLine: 1, anotherLine: 3 });
    });

    test('rejects invalid dates, malformed fields and future dates', () => {
        expect(() => parseShortcutsVisits('2026-02-30 10:00 | A | 到着推定 | GPS推定・本人未確認', { now }))
            .toThrow(/calendar date/);
        expect(() => parseShortcutsVisits('2026-11-08 33:10 | A | 到着推定 | GPS推定・本人未確認', { now }))
            .toThrow(/calendar date/);
        expect(() => parseShortcutsVisits('2026-11-08 10:00 | A | 入店 | GPS推定・本人未確認', { now }))
            .toThrow(/unrecognized record/);
        expect(() => parseShortcutsVisits('2026-12-31 10:00 | A | 到着推定 | GPS推定・本人未確認', { now }))
            .toThrow(/future time/);
    });

    test('refuses an incomplete week or an impossible week start', () => {
        expect(() => parseShortcutsVisits(sample, { now, weekStart: '2026-11-15' }))
            .toThrow(/week not complete/);
        expect(() => parseShortcutsVisits(sample, { now, weekStart: '2026-02-30' }))
            .toThrow(/calendar date/);
    });

    test('keeps boundary events in correct Japan week only', () => {
        const text = [
            '2026-11-07 23:59 | A | 到着推定 | GPS推定・本人未確認',
            '2026-11-08 00:00 | A | 到着推定 | GPS推定・本人未確認',
            '2026-11-14 23:59 | A | 退出推定 | GPS推定・本人未確認',
            '2026-11-15 00:00 | A | 退出推定 | GPS推定・本人未確認',
        ].join('\n');
        const r = parseShortcutsVisits(text, { now, weekStart: '2026-11-08' });
        expect(r.events.map(x => x.date)).toEqual(['2026-11-08', '2026-11-14']);
    });

    test('neutralizes spreadsheet formula-like place names', () => {
        const result = parseShortcutsVisits(
            '2026-11-08 10:00 | =IMPORTXML(unsafe) | 到着推定 | GPS推定・本人未確認', { now });
        expect(result.events[0].place).toMatch(/^'=IMPORTXML/);
    });

    test('fails closed on unexpected copied note prose rather than inventing a record', () => {
        expect(() => parseShortcutsVisits(sample + '\n今日の出来事は楽しかった', { now }))
            .toThrow(/unrecognized record/);
    });
});
