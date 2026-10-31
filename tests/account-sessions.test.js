/* eslint-disable playwright/no-standalone-expect -- Jest callbacks are test blocks. */
import { beforeEach, expect, jest, test } from '@jest/globals';

const records = new Map();
const storage = {
    getItem: jest.fn(async key => records.get(key)),
    setItem: jest.fn(async (key, value) => { records.set(key, value); }),
    removeItem: jest.fn(async key => { records.delete(key); }),
};
jest.unstable_mockModule('node-persist', () => ({ default: storage }));
const { issueAccountSession, extendAccountSession, revokeAccountSession, isAccountSessionActive } = await import('../src/account-sessions.js');

beforeEach(() => {
    records.clear();
    jest.clearAllMocks();
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('logout waits for an in-flight renewal, then permanently removes its record', async () => {
    const request = { session: {} };
    await issueAccountSession(request, 'fictional', 'v1', 60000);
    const entered = deferred();
    const release = deferred();
    storage.setItem.mockImplementationOnce(async (key, value) => {
        entered.resolve();
        await release.promise;
        records.set(key, value);
    });
    const renewal = extendAccountSession(request, 'fictional', 60000);
    await entered.promise;
    const logout = revokeAccountSession(request);
    release.resolve();
    expect(await renewal).toBe(true);
    await logout;
    expect(await extendAccountSession(request, 'fictional', 60000)).toBe(false);
    expect(await isAccountSessionActive(request, 'fictional')).toBe(false);
    expect(records.size).toBe(0);
});

test('renewal queued behind logout cannot recreate a session', async () => {
    const request = { session: {} };
    await issueAccountSession(request, 'fictional', 'v1', 60000);
    const entered = deferred();
    const release = deferred();
    storage.removeItem.mockImplementationOnce(async key => {
        entered.resolve();
        await release.promise;
        records.delete(key);
    });
    const logout = revokeAccountSession(request);
    await entered.promise;
    const renewal = extendAccountSession(request, 'fictional', 60000);
    release.resolve();
    await logout;
    expect(await renewal).toBe(false);
    expect(records.size).toBe(0);
});

test('failed renewal leaves expiry unchanged and does not poison the session queue', async () => {
    const request = { session: {} };
    await issueAccountSession(request, 'fictional', 'v1', 60000);
    const before = [...records.values()][0].expiresAt;
    storage.setItem.mockRejectedValueOnce(new Error('Injected write failure'));
    await expect(extendAccountSession(request, 'fictional', 120000)).rejects.toThrow('Injected write failure');
    expect([...records.values()][0].expiresAt).toBe(before);
    expect(await extendAccountSession(request, 'fictional', 120000)).toBe(true);
    expect([...records.values()][0].expiresAt).toBeGreaterThan(before);
});

test('browser sessions retain their server bound and mismatched accounts cannot renew', async () => {
    const request = { session: {} };
    await issueAccountSession(request, 'fictional', 'v1', undefined);
    const before = [...records.values()][0].expiresAt;
    expect(await extendAccountSession(request, 'other', 60000)).toBe(false);
    expect(await extendAccountSession(request, 'fictional', undefined)).toBe(true);
    expect([...records.values()][0].expiresAt).toBe(before);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
});
