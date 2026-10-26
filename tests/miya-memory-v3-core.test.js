import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sourceCoreDir = fileURLToPath(new URL('../plugins/miya-memory/v3-core/', import.meta.url));

describe('MIYA memory v3 core', () => {
    let tmpDir;
    let addCandidate;
    let readDecisions;
    let readMemories;
    let saveDecision;
    let saveUserMemory;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-memory-v3-'));
        const isolatedCoreDir = path.join(tmpDir, 'v3-core');

        // The core stores files relative to its own directory, so load an isolated copy.
        fs.cpSync(sourceCoreDir, isolatedCoreDir, { recursive: true });

        const requireFromCore = createRequire(path.join(isolatedCoreDir, 'test-loader.cjs'));
        ({ addCandidate } = requireFromCore('./add-candidate.js'));
        ({ readDecisions } = requireFromCore('./read-decisions.js'));
        ({ readMemories } = requireFromCore('./read-memories.js'));
        ({ saveDecision } = requireFromCore('./save-decision.js'));
        ({ saveUserMemory } = requireFromCore('./save-user-memory.js'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('saves and reads a character memory', () => {
        expect(saveUserMemory('fictional_user', 'fictional_character', 'Likes tea')).toEqual({ saved: true });

        expect(readMemories('fictional_user', 'fictional_character').memories).toEqual([
            expect.objectContaining({
                text: 'Likes tea',
                scope: 'character',
            }),
        ]);
    });

    test('does not save the same memory twice', () => {
        saveUserMemory('fictional_user', 'fictional_character', 'Likes tea');

        expect(saveUserMemory('fictional_user', 'fictional_character', 'Likes tea')).toEqual({
            saved: false,
            reason: 'duplicate',
        });
        expect(readMemories('fictional_user', 'fictional_character').memories).toHaveLength(1);
    });

    test('keeps a candidate out of long-term memory until it is approved', () => {
        const candidate = addCandidate('fictional_user', 'fictional_character', 'Likes tea');

        expect(candidate.status).toBe('pending');
        expect(readMemories('fictional_user', 'fictional_character').memories).toEqual([]);
        expect(readDecisions('fictional_user').pending).toContainEqual(candidate);
    });

    test('does not add a normalized duplicate candidate', () => {
        const candidate = addCandidate('fictional_user', 'fictional_character', 'Likes tea');

        expect(addCandidate('fictional_user', 'fictional_character', '  Ｌｉｋｅｓ   tea  ')).toEqual({
            saved: false,
            reason: 'duplicate-candidate',
            candidate,
        });
        expect(readDecisions('fictional_user').pending).toEqual([candidate]);
    });

    test('allows the same candidate for a different character', () => {
        addCandidate('fictional_user', 'fictional_character_a', 'Likes tea');

        expect(addCandidate('fictional_user', 'fictional_character_b', 'Likes tea')).toHaveProperty('status', 'pending');
        expect(readDecisions('fictional_user').pending).toHaveLength(2);
    });

    test('checks normalized duplicates against approved memories', () => {
        saveUserMemory('fictional_user', 'fictional_character', 'Ｌｉｋｅｓ　 tea');

        expect(addCandidate('fictional_user', 'fictional_character', ' Likes   tea ')).toEqual({
            saved: false,
            reason: 'duplicate-memory',
        });
        expect(readDecisions('fictional_user').pending).toEqual([]);
        expect(readMemories('fictional_user', 'fictional_character').memories).toHaveLength(1);
    });

    test('does not deduplicate across users or character memories', () => {
        addCandidate('fictional_user_a', 'fictional_character_a', 'Likes tea');
        saveUserMemory('fictional_user_a', 'fictional_character_b', 'Likes coffee');

        expect(addCandidate('fictional_user_b', 'fictional_character_a', 'Likes tea')).toHaveProperty('status', 'pending');
        expect(addCandidate('fictional_user_a', 'fictional_character_a', 'Likes coffee')).toHaveProperty('status', 'pending');
        expect(readDecisions('fictional_user_a').pending).toHaveLength(2);
        expect(readDecisions('fictional_user_b').pending).toHaveLength(1);
    });

    test('does not duplicate a memory added after the candidate was created', () => {
        const candidate = addCandidate('fictional_user', 'fictional_character', 'Ｌｉｋｅｓ   tea');
        saveUserMemory('fictional_user', 'fictional_character', 'Likes tea');

        expect(saveDecision('fictional_user', candidate.id, 'approve')).toHaveProperty('saved', true);
        expect(readDecisions('fictional_user').pending).toEqual([]);
        expect(readMemories('fictional_user', 'fictional_character').memories.map(item => item.text)).toEqual(['Likes tea']);
    });

    test('holding a candidate does not save it to long-term memory', () => {
        const candidate = addCandidate('fictional_user', 'fictional_character', 'Likes tea');

        expect(saveDecision('fictional_user', candidate.id, 'hold')).toEqual({
            saved: true,
            decision: 'hold',
            candidateId: candidate.id,
        });
        expect(readMemories('fictional_user', 'fictional_character').memories).toEqual([]);
        expect(readDecisions('fictional_user').pending).toContainEqual(candidate);
    });

    test('saves only the approved candidate', () => {
        const approved = addCandidate('fictional_user', 'fictional_character', 'Likes tea');
        const stillPending = addCandidate('fictional_user', 'fictional_character', 'Likes coffee');

        expect(saveDecision('fictional_user', approved.id, 'approve')).toEqual({
            saved: true,
            decision: 'approve',
            candidateId: approved.id,
        });
        expect(readMemories('fictional_user', 'fictional_character').memories.map(item => item.text)).toEqual([
            'Likes tea',
        ]);
        expect(readDecisions('fictional_user').pending).toContainEqual(stillPending);
    });

    test('isolates memories by both user and character', () => {
        saveUserMemory('fictional_user_a', 'fictional_character_a', 'User A character A');
        saveUserMemory('fictional_user_a', 'fictional_character_b', 'User A character B');
        saveUserMemory('fictional_user_b', 'fictional_character_a', 'User B character A');

        expect(readMemories('fictional_user_a', 'fictional_character_a').memories.map(item => item.text)).toEqual([
            'User A character A',
        ]);
        expect(readMemories('fictional_user_a', 'fictional_character_b').memories.map(item => item.text)).toEqual([
            'User A character B',
        ]);
        expect(readMemories('fictional_user_b', 'fictional_character_a').memories.map(item => item.text)).toEqual([
            'User B character A',
        ]);
    });

    test('does not allow another user to approve a candidate', () => {
        const candidate = addCandidate('fictional_owner', 'fictional_character', 'Likes tea');

        expect(() => saveDecision('fictional_other_user', candidate.id, 'approve')).toThrow('存在しない記憶候補です');
        expect(readMemories('fictional_owner', 'fictional_character').memories).toEqual([]);
        expect(readMemories('fictional_other_user', 'fictional_character').memories).toEqual([]);
        expect(readDecisions('fictional_owner').pending).toContainEqual(candidate);
    });

    test('limits pending candidates to 100 without saving the overflow candidate', () => {
        for (let index = 0; index < 100; index++) {
            expect(addCandidate('fictional_user', 'fictional_character', `Fictional memory ${index}`)).toHaveProperty('status', 'pending');
        }

        expect(addCandidate('fictional_user', 'fictional_character', 'Fictional memory overflow')).toEqual({
            saved: false,
            reason: 'pending-limit',
            limit: 100,
            pendingCount: 100,
        });
        expect(readDecisions('fictional_user').pending).toHaveLength(100);
        expect(readMemories('fictional_user', 'fictional_character').memories).toEqual([]);
    });
});
