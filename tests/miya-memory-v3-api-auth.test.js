/* eslint-disable playwright/no-standalone-expect -- Jest test.each callbacks are test blocks, not Playwright standalone assertions. */
import { describe, expect, test } from '@jest/globals';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { init } = require('../plugins/miya-memory/index.js');

function fakeRouter() {
    const handlers = new Map();
    return {
        handlers,
        get(route, handler) { handlers.set('GET ' + route, handler); },
        post(route, handler) { handlers.set('POST ' + route, handler); },
    };
}

function response() {
    return {
        statusCode: 200,
        payload: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.payload = body; return this; },
    };
}

describe('MIYA memory V3 API authorization boundaries', () => {
    test.each([
        ['GET /character-memories', { query: { characterId: 'fictional_character' } }],
        ['GET /decisions-v3', {}],
        ['POST /candidate-v3', { body: { userId: 'forged_user', characterId: 'fictional_character', text: 'Likes tea' } }],
        ['POST /decision-v3', { body: { userId: 'forged_user', candidateId: 'fake-id', decision: 'approve' } }],
    ])('%s denies requests without an authenticated server-side identity', async (route, args) => {
        const router = fakeRouter();
        await init(router);
        const handler = router.handlers.get(route);
        expect(typeof handler).toBe('function');

        const res = response();
        handler({ ...args, user: undefined }, res);

        expect(res.statusCode).toBe(403);
        expect(res.payload).toHaveProperty('error');
    });

    test('a client-supplied userId cannot replace a missing authenticated identity', async () => {
        const router = fakeRouter();
        await init(router);
        const res = response();
        router.handlers.get('GET /character-memories')({
            userId: 'fictional_user',
            query: { userId: 'fictional_user', characterId: 'fictional_character' },
        }, res);
        expect(res.statusCode).toBe(403);
    });

    test('rejects an invalid character ID before reading memories', async () => {
        const router = fakeRouter();
        await init(router);
        const res = response();
        router.handlers.get('GET /character-memories')({
            user: { profile: { handle: 'fictional_user' } },
            query: { characterId: '../another_user' },
        }, res);
        expect(res.statusCode).toBe(400);
    });
});
