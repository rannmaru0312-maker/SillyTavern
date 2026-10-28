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
});
