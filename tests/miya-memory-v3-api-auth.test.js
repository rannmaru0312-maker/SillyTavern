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

function authenticatedRequest(handle) {
    return {
        user: { profile: { handle, enabled: true }, accountSessionValidated: true },
        session: { handle },
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

    test.each([
        ['GET /character-memories', { query: { characterId: 'fictional_character' } }],
        ['GET /decisions-v3', {}],
        ['POST /candidate-v3', { body: { characterId: 'fictional_character', text: 'Should not be stored' } }],
        ['POST /decision-v3', { body: { candidateId: 'fictional-id', decision: 'approve' } }],
    ])('%s fails closed for the disabled-accounts default user and mismatched sessions', async (route, args) => {
        const router = fakeRouter();
        await init(router);
        for (const identity of [
            // SillyTavern's enableUserAccounts=false path fills in DEFAULT_USER.
            { user: { profile: { handle: 'default', enabled: true } }, session: { handle: 'default' } },
            // A session must belong to the same verified account as req.user.
            { user: { profile: { handle: 'fictional_user', enabled: true }, accountSessionValidated: true }, session: { handle: 'other_user' } },
            // Reject even a matching handle when the account is disabled.
            { user: { profile: { handle: 'fictional_user', enabled: false }, accountSessionValidated: true }, session: { handle: 'fictional_user' } },
        ]) {
            const res = response();
            router.handlers.get(route)({ ...args, ...identity }, res);
            expect(res.statusCode).toBe(403);
        }
        expect(fs.existsSync(path.join(tmpDir, 'runtime-data'))).toBe(false);
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
            ...authenticatedRequest('fictional_user'),
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
            ...authenticatedRequest('fictional_user'),
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
            ...authenticatedRequest('fictional_user_a'),
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
            ...authenticatedRequest('fictional_user_a'),
            body: { characterId: 'fictional_character', text: 'Only A can approve' },
        }, added);
        expect(added.statusCode).toBe(201);
        const candidateId = added.payload.candidate.id;

        const forged = response();
        router.handlers.get('POST /decision-v3')({
            ...authenticatedRequest('fictional_user_b'),
            body: { userId: 'fictional_user_a', candidateId, decision: 'approve' },
        }, forged);
        expect(forged.statusCode).toBe(404);

        const pendingFile = path.join(tmpDir, 'runtime-data', 'users', 'fictional_user_a', 'decisions', 'pending.json');
        expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8')).pending).toEqual([
            expect.objectContaining({ id: candidateId, status: 'pending' }),
        ]);
        const readA = response();
        router.handlers.get('GET /character-memories')({
            ...authenticatedRequest('fictional_user_a'),
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
            ...authenticatedRequest('fictional_user_a'),
            body: { characterId: 'fictional_character', text: 'A only' },
        }, added);
        expect(added.statusCode).toBe(201);

        const asB = response();
        router.handlers.get('GET /decisions-v3')({
            ...authenticatedRequest('fictional_user_b'),
            query: { userId: 'fictional_user_a' },
        }, asB);
        expect(asB.statusCode).toBe(200);
        expect(asB.payload.pending).toEqual([]);

        const asA = response();
        router.handlers.get('GET /decisions-v3')({
            ...authenticatedRequest('fictional_user_a'),
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
            ...authenticatedRequest('fictional_user_a'),
            body: { characterId: 'fictional_character_a', text: 'For A character A' },
        }, createA);
        expect(createA.statusCode).toBe(201);

        const approveA = response();
        router.handlers.get('POST /decision-v3')({
            ...authenticatedRequest('fictional_user_a'),
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
                ...authenticatedRequest(userId),
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
                ...authenticatedRequest('../outside'),
            }, res);
            expect(res.statusCode).toBe(403);
        }
        expect(fs.existsSync(path.join(tmpDir, 'runtime-data'))).toBe(false);
    });


    test('holding a candidate never writes long-term memory; approval saves it once', async () => {
        const router = fakeRouter();
        await init(router);

        const added = response();
        router.handlers.get('POST /candidate-v3')({
            ...authenticatedRequest('fictional_user_a'),
            body: { characterId: 'fictional_character', text: 'Pending until approval' },
        }, added);
        expect(added.statusCode).toBe(201);
        const candidateId = added.payload.candidate.id;

        const readMemories = () => {
            const res = response();
            router.handlers.get('GET /character-memories')({
                ...authenticatedRequest('fictional_user_a'),
                query: { characterId: 'fictional_character' },
            }, res);
            expect(res.statusCode).toBe(200);
            return res.payload.memories;
        };

        expect(readMemories()).toEqual([]);

        const held = response();
        router.handlers.get('POST /decision-v3')({
            ...authenticatedRequest('fictional_user_a'),
            body: { candidateId, decision: 'hold' },
        }, held);
        expect(held.statusCode).toBe(200);
        expect(readMemories()).toEqual([]);

        const pendingWhileHeld = response();
        router.handlers.get('GET /decisions-v3')({
            ...authenticatedRequest('fictional_user_a'),
        }, pendingWhileHeld);
        expect(pendingWhileHeld.statusCode).toBe(200);
        expect(pendingWhileHeld.payload.pending).toEqual([
            expect.objectContaining({ id: candidateId, status: 'pending' }),
        ]);

        const approved = response();
        router.handlers.get('POST /decision-v3')({
            ...authenticatedRequest('fictional_user_a'),
            body: { candidateId, decision: 'approve' },
        }, approved);
        expect(approved.statusCode).toBe(200);
        expect(readMemories()).toEqual([
            expect.objectContaining({ text: 'Pending until approval' }),
        ]);

        const decisions = response();
        router.handlers.get('GET /decisions-v3')({
            ...authenticatedRequest('fictional_user_a'),
        }, decisions);
        expect(decisions.payload.pending).toEqual([]);
    });


    test('pending duplicates are scoped to the authenticated user and character', async () => {
        const router = fakeRouter();
        await init(router);
        const create = (userId, characterId) => {
            const res = response();
            router.handlers.get('POST /candidate-v3')({
                ...authenticatedRequest(userId),
                body: { characterId, text: 'An identical fictional preference', userId: 'untrusted_client_id' },
            }, res);
            return res;
        };

        expect(create('fictional_user_a', 'fictional_character_a').statusCode).toBe(201);
        const duplicate = create('fictional_user_a', 'fictional_character_a');
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.payload.reason).toBe('duplicate-candidate');

        expect(create('fictional_user_a', 'fictional_character_b').statusCode).toBe(201);
        expect(create('fictional_user_b', 'fictional_character_a').statusCode).toBe(201);

        for (const [userId, expectedCharacters] of [
            ['fictional_user_a', ['fictional_character_a', 'fictional_character_b']],
            ['fictional_user_b', ['fictional_character_a']],
        ]) {
            const res = response();
            router.handlers.get('GET /decisions-v3')({
                ...authenticatedRequest(userId),
                query: { userId: 'untrusted_client_id' },
            }, res);
            expect(res.statusCode).toBe(200);
            expect(res.payload.pending.map(item => item.characterId).sort()).toEqual(expectedCharacters);
        }
    });

    test('approved memory cannot be requeued as another pending candidate', async () => {
        const router = fakeRouter();
        await init(router);
        const add = () => {
            const res = response();
            router.handlers.get('POST /candidate-v3')({
                ...authenticatedRequest('fictional_user_a'),
                body: { characterId: 'fictional_character_a', text: 'A confirmed fictional preference' },
            }, res);
            return res;
        };
        const created = add();
        expect(created.statusCode).toBe(201);
        const approved = response();
        router.handlers.get('POST /decision-v3')({
            ...authenticatedRequest('fictional_user_a'),
            body: { candidateId: created.payload.candidate.id, decision: 'approve' },
        }, approved);
        expect(approved.statusCode).toBe(200);

        const duplicate = add();
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.payload.reason).toBe('duplicate-memory');

        const decisions = response();
        router.handlers.get('GET /decisions-v3')({
            ...authenticatedRequest('fictional_user_a'),
        }, decisions);
        expect(decisions.payload.pending).toEqual([]);

        const memories = response();
        router.handlers.get('GET /character-memories')({
            ...authenticatedRequest('fictional_user_a'),
            query: { characterId: 'fictional_character_a' },
        }, memories);
        expect(memories.payload.memories.map(item => item.text)).toEqual(['A confirmed fictional preference']);
    });

    test.each([
        ['traversal characterId', { characterId: '../escape', text: 'Fictional value' }],
        ['empty text', { characterId: 'fictional_character', text: '   ' }],
        ['oversized text', { characterId: 'fictional_character', text: 'x'.repeat(2001) }],
        ['oversized reason', { characterId: 'fictional_character', text: 'Fictional value', reason: 'x'.repeat(1001) }],
    ])('candidate API rejects %s before creating any storage', async (_reason, body) => {
        const router = fakeRouter();
        await init(router);
        const res = response();
        router.handlers.get('POST /candidate-v3')({
            ...authenticatedRequest('fictional_user_a'),
            body,
        }, res);
        expect(res.statusCode).toBe(400);
        expect(fs.existsSync(path.join(tmpDir, 'runtime-data'))).toBe(false);
    });


    test('100 pending candidates are isolated per user and approval frees exactly one slot', async () => {
        const router = fakeRouter();
        await init(router);

        const add = (userId, text, characterId = 'fictional_character_a') => {
            const res = response();
            router.handlers.get('POST /candidate-v3')({
                ...authenticatedRequest(userId),
                body: {
                    userId: 'untrusted_client_id',
                    characterId,
                    text,
                },
            }, res);
            return res;
        };

        const decisionsFor = (userId) => {
            const res = response();
            router.handlers.get('GET /decisions-v3')({
                ...authenticatedRequest(userId),
                query: { userId: 'untrusted_client_id' },
            }, res);
            expect(res.statusCode).toBe(200);
            return res.payload.pending;
        };

        let firstCandidateId;
        for (let index = 0; index < 100; index++) {
            const created = add('fictional_user_a', `Fictional pending preference ${index}`);
            expect(created.statusCode).toBe(201);
            if (index === 0) firstCandidateId = created.payload.candidate.id;
        }
        expect(decisionsFor('fictional_user_a')).toHaveLength(100);

        const overflow = add('fictional_user_a', 'Fictional preference over the limit');
        expect(overflow.statusCode).toBe(409);
        expect(overflow.payload).toEqual(expect.objectContaining({
            reason: 'pending-limit',
            limit: 100,
            pendingCount: 100,
        }));
        // The pending cap applies to the whole authenticated user, not to one character.
        const crossCharacterOverflow = add('fictional_user_a', 'New preference for another character', 'fictional_character_b');
        expect(crossCharacterOverflow.statusCode).toBe(409);
        expect(crossCharacterOverflow.payload).toEqual(expect.objectContaining({
            reason: 'pending-limit',
            pendingCount: 100,
        }));
        expect(decisionsFor('fictional_user_a')).toHaveLength(100);

        // Even at capacity, an existing candidate is reported as a duplicate,
        // rather than silently creating or overwriting another pending item.
        const duplicate = add('fictional_user_a', 'Fictional pending preference 0');
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.payload.reason).toBe('duplicate-candidate');

        const held = response();
        router.handlers.get('POST /decision-v3')({
            ...authenticatedRequest('fictional_user_a'),
            body: { candidateId: firstCandidateId, decision: 'hold' },
        }, held);
        expect(held.statusCode).toBe(200);
        expect(add('fictional_user_a', 'Hold does not free a slot').payload.reason).toBe('pending-limit');
        expect(decisionsFor('fictional_user_a')).toHaveLength(100);

        // Capacity is per authenticated user, not shared globally.
        expect(add('fictional_user_b', 'Fictional preference for B').statusCode).toBe(201);
        expect(decisionsFor('fictional_user_b')).toHaveLength(1);

        const approved = response();
        router.handlers.get('POST /decision-v3')({
            ...authenticatedRequest('fictional_user_a'),
            body: { candidateId: firstCandidateId, decision: 'approve' },
        }, approved);
        expect(approved.statusCode).toBe(200);
        expect(decisionsFor('fictional_user_a')).toHaveLength(99);

        const replacement = add('fictional_user_a', 'New candidate after explicit approval', 'fictional_character_b');
        expect(replacement.statusCode).toBe(201);
        const pending = decisionsFor('fictional_user_a');
        expect(pending).toHaveLength(100);
        expect(pending.some(item => item.id === firstCandidateId)).toBe(false);
        expect(pending).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: replacement.payload.candidate.id,
                characterId: 'fictional_character_b',
            }),
        ]));
        expect(decisionsFor('fictional_user_b')).toHaveLength(1);

        const memories = response();
        router.handlers.get('GET /character-memories')({
            ...authenticatedRequest('fictional_user_a'),
            query: { characterId: 'fictional_character_a' },
        }, memories);
        expect(memories.statusCode).toBe(200);
        expect(memories.payload.memories.map(item => item.text)).toEqual(['Fictional pending preference 0']);
    });

    test.each([
        ['traversal candidateId', { candidateId: '../another_user', decision: 'approve' }],
        ['missing candidateId', { decision: 'approve' }],
        ['unsupported decision', { candidateId: 'fictional_candidate', decision: 'delete' }],
        ['missing decision', { candidateId: 'fictional_candidate' }],
    ])('decision API rejects %s before creating storage', async (_case, body) => {
        const router = fakeRouter();
        await init(router);
        const res = response();
        router.handlers.get('POST /decision-v3')({
            ...authenticatedRequest('fictional_user_a'),
            body,
        }, res);
        expect(res.statusCode).toBe(400);
        expect(fs.existsSync(path.join(tmpDir, 'runtime-data'))).toBe(false);
    });

});
