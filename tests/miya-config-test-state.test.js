import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, setConfigFilePathForTests } from '../src/util.js';

describe('test-only config path and cache isolation', () => {
    test('restores prior config path and cached config even if source file changes', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-config-state-'));
        const baseline = path.join(root, 'baseline.yaml');
        const temporary = path.join(root, 'temporary.yaml');
        fs.writeFileSync(baseline, 'fixtureKey: baseline-value\n');
        fs.writeFileSync(temporary, 'fixtureKey: temporary-value\n');

        let restoreBaseline;
        let restoreTemporary;
        try {
            restoreBaseline = setConfigFilePathForTests(baseline);
            // Restore before the baseline is cached to verify the path itself,
            // rather than accidentally passing through a stale cached value.
            const restoreBeforeCache = setConfigFilePathForTests(temporary);
            restoreBeforeCache();
            expect(getConfig().fixtureKey).toBe('baseline-value');
            const originalCachedConfig = getConfig();
            restoreTemporary = setConfigFilePathForTests(temporary);
            expect(getConfig().fixtureKey).toBe('temporary-value');

            // A cache restoration should preserve the object already loaded,
            // not silently reload a changed file.
            fs.writeFileSync(baseline, 'fixtureKey: modified-after-cache\n');
            restoreTemporary();
            restoreTemporary = null;
            expect(getConfig()).toBe(originalCachedConfig);
            expect(getConfig().fixtureKey).toBe('baseline-value');

            // The restored path is used after its original cache is cleared.
            const restoreAfterCache = setConfigFilePathForTests(temporary);
            try {
                expect(getConfig().fixtureKey).toBe('temporary-value');
            } finally {
                restoreAfterCache();
            }
            expect(getConfig()).toBe(originalCachedConfig);
        } finally {
            if (restoreTemporary) restoreTemporary();
            if (restoreBaseline) restoreBaseline();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('restoration callback is idempotent and cannot overwrite a newer override', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-config-restore-'));
        const baseline = path.join(root, 'baseline.yaml');
        const temporary = path.join(root, 'temporary.yaml');
        const newer = path.join(root, 'newer.yaml');
        fs.writeFileSync(baseline, 'fixtureKey: baseline-restored\n');
        fs.writeFileSync(temporary, 'fixtureKey: first-override\n');
        fs.writeFileSync(newer, 'fixtureKey: second-override\n');

        let restoreBaseline;
        let restoreTemporary;
        let restoreNewer;
        try {
            restoreBaseline = setConfigFilePathForTests(baseline);
            const baselineCache = getConfig();
            restoreTemporary = setConfigFilePathForTests(temporary);
            expect(getConfig().fixtureKey).toBe('first-override');

            restoreTemporary();
            expect(getConfig()).toBe(baselineCache);

            // A stale restore callback must not undo a later active override.
            restoreNewer = setConfigFilePathForTests(newer);
            const newerCache = getConfig();
            expect(newerCache.fixtureKey).toBe('second-override');
            restoreTemporary();
            expect(getConfig()).toBe(newerCache);

            restoreNewer();
            restoreNewer = null;
            expect(getConfig()).toBe(baselineCache);
        } finally {
            if (restoreNewer) restoreNewer();
            if (restoreTemporary) restoreTemporary();
            if (restoreBaseline) restoreBaseline();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('rejects test-only override outside test mode', () => {
        const previous = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            expect(() => setConfigFilePathForTests('must-not-be-used.yaml'))
                .toThrow('Temporary config override is available only in test mode.');
        } finally {
            if (previous === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previous;
        }
    });
});
