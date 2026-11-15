import { beforeEach, afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../plugins/miya-memory/visits-import-v1-api.js');
const EVENT = {
    event_id: '123e4567-e89b-42d3-a456-426614174000',
    place_id: '123e4567-e89b-42d3-a456-426614174001',
    place_name: 'Test cafe',
    kind: 'entry',
    detected_at: '2026-11-15T00:00:00Z',
    confirmed_at: null,
    source: 'ios_geofence',
    schema_version: 1,
};
const user = (handle) => ({ user: { profile: { handle, enabled: true } }, session: { handle } });
function fakeRouter() {
    const routes = new Map();
    return { routes,
        post(url, fn) { routes.set('POST ' + url, fn); },
        get(url, fn) { routes.set('GET ' + url, fn); } };
}
function reply() {
    return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; },
        json(x) { this.body = x; return this; }, set() { return this; } };
}

describe('MIYA opt-in visit import', () => {
    let temp, previous, router;
    beforeEach(() => {
        temp = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-visit-test-'));
        previous = { enabled: process.env.MIYA_VISIT_IMPORT_ENABLED, dir: process.env.MIYA_VISIT_DATA_DIR };
        process.env.MIYA_VISIT_IMPORT_ENABLED = '1';
        process.env.MIYA_VISIT_DATA_DIR = temp;
        router = fakeRouter();
        register(router);
    });
    afterEach(() => {
        if (previous.enabled === undefined) delete process.env.MIYA_VISIT_IMPORT_ENABLED;
        else process.env.MIYA_VISIT_IMPORT_ENABLED = previous.enabled;
        if (previous.dir === undefined) delete process.env.MIYA_VISIT_DATA_DIR;
        else process.env.MIYA_VISIT_DATA_DIR = previous.dir;
        fs.rmSync(temp, { recursive: true, force: true });
    });
    const send = (router, req) => {
        const res = reply();
        router.routes.get('POST /visits/import-v1')(req, res);
        return res;
    };
    const get = (router, req) => {
        const res = reply();
        router.routes.get('GET /visits/export-v1')(req, res);
        return res;
    };

    test('disabled by default, never writing to disk', () => {
        delete process.env.MIYA_VISIT_IMPORT_ENABLED;
        const res = send(router, { ...user('tester'), body: { events: [EVENT] } });
        expect(res.statusCode).toBe(404);
        expect(fs.readdirSync(temp)).toHaveLength(0);
    });
    test('requires matching server-side session even with forged client user ID', () => {
        const missing = send(router, { body: { events: [EVENT], userId: 'tester' } });
        expect(missing.statusCode).toBe(403);
        const mismatch = send(router, { user: { profile: { handle: 'tester' } },
            session: { handle: 'victim' }, body: { events: [EVENT] } });
        expect(mismatch.statusCode).toBe(403);
        expect(fs.readdirSync(temp)).toHaveLength(0);
    });
    test('is idempotent and stores locally per account', () => {
        const req = { ...user('alice'), body: { events: [EVENT] } };
        expect(send(router, req).body).toMatchObject({ success: true, added: 1, duplicates: 0 });
        expect(send(router, req).body).toMatchObject({ success: true, added: 0, duplicates: 1 });
        expect(get(router, user('alice')).body.events).toHaveLength(1);
        expect(get(router, user('bob')).body.events).toHaveLength(0);
        expect(fs.existsSync(path.join(temp, 'alice.json'))).toBe(true);
        expect(fs.existsSync(path.join(temp, 'bob.json'))).toBe(false);
    });
    test('rejects conflict, invalid timestamp, and extra fields', () => {
        const base = { ...user('alice'), body: { events: [EVENT] } };
        expect(send(router, base).statusCode).toBe(200);
        const conflict = send(router, { ...user('alice'),
            body: { events: [{ ...EVENT, place_name: 'Different' }] } });
        expect(conflict.statusCode).toBe(409);
        const invalid = send(router, { ...user('alice'),
            body: { events: [{ ...EVENT, detected_at: 'tomorrow' }] } });
        expect(invalid.statusCode).toBe(400);
        const extra = send(router, { ...user('alice'),
            body: { events: [{ ...EVENT, secret: 'not allowed' }] } });
        expect(extra.statusCode).toBe(400);
        expect(get(router, user('alice')).body.events).toHaveLength(1);
    });
    test('server-side delete is explicit, account-scoped, and idempotent', () => {
        const alice = user('alice');
        const bob = user('bob');
        expect(send(router, { ...alice, body: { events: [EVENT] } }).statusCode).toBe(200);
        expect(send(router, { ...bob, body: { events: [EVENT] } }).statusCode).toBe(200);
        const erase = router.routes.get('POST /visits/delete-v1');
        const invalid = reply();
        erase({ ...alice, body: { confirm: 'not-yet' } }, invalid);
        expect(invalid.statusCode).toBe(400);
        const unauth = reply();
        erase({ body: { confirm: 'DELETE_MY_VISIT_EVENTS' } }, unauth);
        expect(unauth.statusCode).toBe(403);
        const okay = reply();
        erase({ ...alice, body: { confirm: 'DELETE_MY_VISIT_EVENTS' } }, okay);
        expect(okay.body).toMatchObject({ success: true, deleted: 1 });
        expect(get(router, alice).body.events).toEqual([]);
        expect(get(router, bob).body.events).toHaveLength(1);
        const again = reply();
        erase({ ...alice, body: { confirm: 'DELETE_MY_VISIT_EVENTS' } }, again);
        expect(again.body).toMatchObject({ success: true, deleted: 0 });
    });
    test('bounds batch size and fails closed if storage configuration is missing', () => {
        const excessive = send(router, { ...user('alice'), body: { events: Array(21).fill(EVENT) } });
        expect(excessive.statusCode).toBe(400);
        delete process.env.MIYA_VISIT_DATA_DIR;
        const disabled = send(router, { ...user('alice'), body: { events: [EVENT] } });
        expect(disabled.statusCode).toBe(404);
    });
});
