import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pluginDir = fileURLToPath(new URL('../plugins/miya-memory/', import.meta.url));

describe('MIYA memory API isolation', () => {
    let tmpDir;
    let server;
    let baseUrl;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-api-'));
        const isolatedPlugin = path.join(tmpDir, 'plugin');
        fs.cpSync(pluginDir, isolatedPlugin, {
            recursive: true,
            filter: source => path.basename(source) !== 'runtime-data',
        });
        const requirePlugin = createRequire(path.join(isolatedPlugin, 'loader.cjs'));
        const app = express();
        app.use(express.json());
        // Test-only authentication fixture; production authentication is provided by the host.
        app.use((req, res, next) => {
            if (req.headers['x-test-user']) {
                req.user = { profile: { handle: req.headers['x-test-user'] } };
            }
            next();
        });
        const router = express.Router();
        await requirePlugin('./index.js').init(router);
        app.use(router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function request(route, user, body) {
        return fetch(`${baseUrl}${route}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(user ? { 'X-Test-User': user } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }

    test('requires host authentication for every memory route', async () => {
        for (const [route, body] of [
            ['/candidate-v3', { characterId: 'fictional_character', text: 'Likes tea', userId: 'fictional_owner' }],
            ['/decision-v3', { candidateId: 'fictional_candidate', decision: 'approve' }],
            ['/decisions-v3', undefined],
            ['/character-memories?characterId=fictional_character', undefined],
        ]) {
            const response = await request(route, null, body);
            expect(response.status).toBe(403);
        }
    });

    test('uses the authenticated owner and rejects cross-user approval', async () => {
        const response = await request('/candidate-v3', 'fictional_owner', {
            userId: 'fictional_other', characterId: 'fictional_character', text: 'Likes tea',
        });
        expect(response.status).toBe(201);
        const { candidate } = await response.json();
        const otherDecisions = await request('/decisions-v3', 'fictional_other');
        expect((await otherDecisions.json()).pending).toEqual([]);
        const otherApproval = await request('/decision-v3', 'fictional_other', {
            candidateId: candidate.id, decision: 'approve', userId: 'fictional_owner',
        });
        expect(otherApproval.status).toBe(404);
        const ownerDecisions = await request('/decisions-v3', 'fictional_owner');
        expect((await ownerDecisions.json()).pending).toEqual([candidate]);
        const ownerMemories = await request('/character-memories?characterId=fictional_character', 'fictional_owner');
        expect((await ownerMemories.json()).memories).toEqual([]);
    });

    test('holds without saving, then approves only for the selected character', async () => {
        const response = await request('/candidate-v3', 'fictional_owner', {
            characterId: 'fictional_character', text: 'Likes tea',
        });
        const { candidate } = await response.json();
        const held = await request('/decision-v3', 'fictional_owner', { candidateId: candidate.id, decision: 'hold' });
        expect(held.status).toBe(200);
        const before = await request('/character-memories?characterId=fictional_character', 'fictional_owner');
        expect((await before.json()).memories).toEqual([]);
        const approved = await request('/decision-v3', 'fictional_owner', { candidateId: candidate.id, decision: 'approve' });
        expect(approved.status).toBe(200);
        const after = await request('/character-memories?characterId=fictional_character', 'fictional_owner');
        expect((await after.json()).memories.map(item => item.text)).toEqual(['Likes tea']);
        const other = await request('/character-memories?characterId=fictional_other_character', 'fictional_owner');
        expect((await other.json()).memories).toEqual([]);
        const duplicate = await request('/candidate-v3', 'fictional_owner', {
            characterId: 'fictional_character', text: 'Ｌｉｋｅｓ   tea',
        });
        expect(duplicate.status).toBe(409);
        expect((await duplicate.json()).reason).toBe('duplicate-memory');
    });

    test('rejects traversal IDs before accessing the memory store', async () => {
        const response = await request('/candidate-v3', 'fictional_owner', {
            characterId: '../outside', text: 'Likes tea',
        });
        expect(response.status).toBe(400);
        const invalidUser = await request('/decisions-v3', '../outside');
        expect(invalidUser.status).toBe(403);
    });
});
