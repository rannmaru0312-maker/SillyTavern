/* eslint-disable playwright/no-standalone-expect -- Jest test.each callbacks are test blocks, not Playwright standalone assertions. */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sourcePluginDir = fileURLToPath(new URL('../plugins/miya-memory/', import.meta.url));

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
    let tmpDir;
    let init;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-memory-v3-api-'));

        // Storage is relative to the loaded core's directory. Copy code only,
        // never runtime-data, so even a broken auth guard writes into this fixture.
        for (const file of ['index.js', 'add-candidate-v3-api.js', 'add-decision-v3-api.js']) {
            fs.copyFileSync(path.join(sourcePluginDir, file), path.join(tmpDir, file));
        }
        const sourceCoreDir = path.join(sourcePluginDir, 'v3-core');
        const isolatedCoreDir = path.join(tmpDir, 'v3-core');
        fs.mkdirSync(isolatedCoreDir);
        for (const entry of fs.readdirSync(sourceCoreDir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.js')) {
                fs.copyFileSync(path.join(sourceCoreDir, entry.name), path.join(isolatedCoreDir, entry.name));
            }
        }

        const requireFromPlugin = createRequire(path.join(tmpDir, 'test-loader.cjs'));
        ({ init } = requireFromPlugin('./index.js'));
    });

    afterEach(() => {
        if (tmpDir) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            tmpDir = undefined;
        }
    });

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

    test('stores a candidate reached through the route in the temporary fixture', async () => {
        const runtimeDir = path.join(tmpDir, 'runtime-data');
        expect(fs.existsSync(runtimeDir)).toBe(false);

        const router = fakeRouter();
        await init(router);
        const res = response();
        router.handlers.get('POST /candidate-v3')({
            user: { profile: { handle: 'fictional_user' } },
            body: { characterId: 'fictional_character', text: 'Likes tea' },
        }, res);

        expect(res.statusCode).toBe(201);
        const pendingFile = path.join(runtimeDir, 'users', 'fictional_user', 'decisions', 'pending.json');
        const pendingData = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        expect(pendingData.pending).toEqual([
            expect.objectContaining({ text: 'Likes tea', characterId: 'fictional_character', status: 'pending' }),
        ]);
    });

    test('authenticated user ignores a forged userId when saving candidates', async () => {
        const router = fakeRouter();
        await init(router);

        const res = response();
        router.handlers.get('POST /candidate-v3')({
            user: { profile: { handle: 'fictional_user_a' } },
            body: {
                userId: 'fictional_user_b',
                characterId: 'fictional_character',
                text: 'A private fictional preference',
            },
        }, res);
        expect(res.statusCode).toBe(201);

        const userADecisions = path.join(tmpDir, 'runtime-data', 'users', 'fictional_user_a', 'decisions', 'pending.json');
        const userBDir = path.join(tmpDir, 'runtime-data', 'users', 'fictional_user_b');
        expect(JSON.parse(fs.readFileSync(userADecisions, 'utf8')).pending).toEqual([
            expect.objectContaining({ text: 'A private fictional preference' }),
        ]);
        expect(fs.existsSync(userBDir)).toBe(false);
    });

    test('authenticated user cannot approve another user\'s pending candidate', async () => {
        const router = fakeRouter();
        await init(router);

        const added = response();
        router.handlers.get('POST /candidate-v3')({
            user: { profile: { handle: 'fictional_user_a' } },
            body: { characterId: 'fictional_character', text: 'Only A can approve' },
        }, added);
        expect(added.statusCode).toBe(201);
        const candidateId = added.payload.candidate.id;

        const forged = response();
        router.handlers.get('POST /decision-v3')({
            user: { profile: { handle: 'fictional_user_b' } },
            body: { userId: 'fictional_user_a', candidateId, decision: 'approve' },
        }, forged);
        expect(forged.statusCode).toBe(404);

        const pendingFile = path.join(tmpDir, 'runtime-data', 'users', 'fictional_user_a', 'decisions', 'pending.json');
        expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8')).pending).toEqual([
            expect.objectContaining({ id: candidateId, status: 'pending' }),
        ]);
        const readA = response();
        router.handlers.get('GET /character-memories')({
            user: { profile: { handle: 'fictional_user_a' } },
            query: { characterId: 'fictional_character' },
        }, readA);
        expect(readA.statusCode).toBe(200);
        expect(readA.payload.memories).toEqual([]);
    });

    test('decisions endpoint ignores another userId in query and reads only authenticated user', async () => {
        const router = fakeRouter();
        await init(router);

        const added = response();
        router.handlers.get('POST /candidate-v3')({
            user: { profile: { handle: 'fictional_user_a' } },
            body: { characterId: 'fictional_character', text: 'A only' },
        }, added);
        expect(added.statusCode).toBe(201);

        const asB = response();
        router.handlers.get('GET /decisions-v3')({
            user: { profile: { handle: 'fictional_user_b' } },
            query: { userId: 'fictional_user_a' },
        }, asB);
        expect(asB.statusCode).toBe(200);
        expect(asB.payload.pending).toEqual([]);

        const asA = response();
        router.handlers.get('GET /decisions-v3')({
            user: { profile: { handle: 'fictional_user_a' } },
            query: { userId: 'fictional_user_b' },
        }, asA);
        expect(asA.statusCode).toBe(200);
        expect(asA.payload.pending).toEqual([
            expect.objectContaining({ text: 'A only', characterId: 'fictional_character' }),
        ]);
    });

    test('character memory route keeps approved memories separate by character and user', async () => {
        const router = fakeRouter();
        await init(router);

        const createA = response();
        router.handlers.get('POST /candidate-v3')({
            user: { profile: { handle: 'fictional_user_a' } },
            body: { characterId: 'fictional_character_a', text: 'For A character A' },
        }, createA);
        expect(createA.statusCode).toBe(201);

        const approveA = response();
        router.handlers.get('POST /decision-v3')({
            user: { profile: { handle: 'fictional_user_a' } },
            body: { candidateId: createA.payload.candidate.id, decision: 'approve' },
        }, approveA);
        expect(approveA.statusCode).toBe(200);

        for (const [userId, characterId, expected] of [
            ['fictional_user_a', 'fictional_character_a', ['For A character A']],
            ['fictional_user_a', 'fictional_character_b', []],
            ['fictional_user_b', 'fictional_character_a', []],
        ]) {
            const read = response();
            router.handlers.get('GET /character-memories')({
                user: { profile: { handle: userId } },
                query: { characterId, userId: 'fictional_user_a' },
            }, read);
            expect(read.statusCode).toBe(200);
            expect(read.payload.memories.map(item => item.text)).toEqual(expected);
        }
    });

    test('invalid server-side identity is rejected without creating storage', async () => {
        const router = fakeRouter();
        await init(router);
        for (const [method, route, args] of [
            ['GET', '/character-memories', { query: { characterId: 'fictional_character' } }],
            ['GET', '/decisions-v3', {}],
            ['POST', '/candidate-v3', { body: { characterId: 'fictional_character', text: 'No write' } }],
            ['POST', '/decision-v3', { body: { candidateId: 'fake-id', decision: 'approve' } }],
        ]) {
            const res = response();
            router.handlers.get(method + ' ' + route)({
                ...args,
                user: { profile: { handle: '../outside' } },
            }, res);
            expect(res.statusCode).toBe(403);
        }
        expect(fs.existsSync(path.join(tmpDir, 'runtime-data'))).toBe(false);
    });

});
