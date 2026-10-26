import { describe, expect, test } from '@jest/globals';
import { detectMemoryCandidate } from '../public/scripts/extensions/third-party/miya-memory-manager/candidate-rules.js';

describe('MIYA memory candidate rules', () => {
    const extractable = [
        ['私は猫が好きです', '利用者の好み'],
        ['好きな食べ物は寿司です', '利用者の好み'],
        ['趣味は読書です', '利用者の趣味'],
        ['これからは短く答えてください', '継続的な希望'],
        ['覚えておいて、私は紅茶が好きです', '利用者の明示的な記憶依頼'],
    ];

    for (const [text, reason] of extractable) {
        test(`extracts persistent fictional user preference: ${text}`, () => {
            expect(detectMemoryCandidate(text)).toEqual({ text, reason });
        });
    }

    const rejected = [
        'うん、そうだね',
        '今日は映画を見ます',
        '今回だけ丁寧に答えてください',
        '覚えておいてください',
        '覚えて、明日だけ話します',
        '私の住所は東京都千代田区です',
        '覚えて、私は東京都に住んでいます',
        '私の誕生日は4月1日です',
        '友人の名前は花子です',
        '友達は寿司が好きです',
        '連絡先はuser@example.comです',
        '母は糖尿病です',
    ];

    for (const text of rejected) {
        test(`does not extract transient, sensitive, or third-party information: ${text}`, () => {
            expect(detectMemoryCandidate(text)).toBeNull();
        });
    }

    test('rejects invalid input and overlong messages', () => {
        expect(detectMemoryCandidate(null)).toBeNull();
        expect(detectMemoryCandidate('x'.repeat(501))).toBeNull();
    });
});
