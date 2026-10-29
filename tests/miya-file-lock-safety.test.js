/* eslint-disable playwright/no-standalone-expect -- Jest tests use @jest/globals, not Playwright. */
import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withFileLock } = require('../plugins/miya-memory/v3-core/file-lock.js');

describe('MIYA lock recovery safety', () => {
    test('contested lock is never removed automatically, including a seemingly stale PID', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-lock-safety-'));
        const file = path.join(root, 'pending.json');
        const lockFile = file + '.lock';
        const marker = JSON.stringify({ pid: 99999999, createdAt: '2000-01-01T00:00:00.000Z' }) + '\n';
        try {
            fs.writeFileSync(lockFile, marker, { flag: 'wx', mode: 0o600 });
            expect(() => withFileLock(file, () => {
                throw new Error('must not enter critical section');
            })).toThrow(/ロック取得がタイムアウトしました/);
            expect(fs.readFileSync(lockFile, 'utf8')).toBe(marker);

            // Recovery requires a deliberate, offline ownership check.
            fs.unlinkSync(lockFile);
            expect(withFileLock(file, () => 'recovered')).toBe('recovered');
            expect(fs.existsSync(lockFile)).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 15000);

    test('successful critical section releases its lock', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-lock-release-'));
        const file = path.join(root, 'pending.json');
        try {
            expect(withFileLock(file, () => {
                expect(fs.existsSync(file + '.lock')).toBe(true);
                return 42;
            })).toBe(42);
            expect(fs.existsSync(file + '.lock')).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
