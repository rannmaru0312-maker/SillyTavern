import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../plugins/miya-memory/visits-import-v1-api.js');
const FIXTURE = {
    event_id: '123e4567-e89b-42d3-a456-426614174000',
    place_id: '123e4567-e89b-42d3-a456-426614174001',
    place_name: 'Fictional cafe',
    kind: 'entry',
    detected_at: '2026-11-15T01:00:00Z',
    confirmed_at: null,
    source: 'ios_geofence',
    schema_version: 1,
};

function makeClient(port) {
    const cookies = new Map();
    return async (method, endpoint, body, token) => new Promise((resolve, reject) => {
        const headers = { 'content-type': 'application/json' };
        if (token) headers['x-csrf-token'] = token;
        if (cookies.size > 0) headers.cookie = [...cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
        const data = body ? JSON.stringify(body) : '';
        if (data) headers['content-length'] = Buffer.byteLength(data);
        const req = http.request({ host: '127.0.0.1', port, method, path: endpoint, headers }, res => {
            for (const line of res.headers['set-cookie'] || []) {
                const cookie = line.split(';')[0];
                const index = cookie.indexOf('=');
                const key = cookie.slice(0, index);
                const value = cookie.slice(index + 1);
                if (value) cookies.set(key, value);
                else cookies.delete(key);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let result = {};
                try { result = JSON.parse(text); } catch { /* Some errors are plain HTML. */ }
                resolve({ status: res.statusCode, body: result });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

describe('Visit import: actual HTTP cookies and CSRF middleware (isolated test server)', () => {
    let temp, previous, server, port;
    beforeEach(async () => {
        temp = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-visit-http-'));
        previous = { enabled: process.env.MIYA_VISIT_IMPORT_ENABLED, dir: process.env.MIYA_VISIT_DATA_DIR };
        process.env.MIYA_VISIT_IMPORT_ENABLED = '1';
        process.env.MIYA_VISIT_DATA_DIR = temp;

        const app = express();
        app.use(express.json({ limit: '32kb' }));
        app.use(cookieSession({ name: 'session', secret: 'isolated-test-only-secret', sameSite: 'lax', httpOnly: true }));
        app.use((req, _res, next) => {
            const handle = req.session?.handle;
            if (handle) req.user = { profile: { handle, enabled: true } };
            next();
        });
        const csrf = csrfSync({
            getTokenFromState: req => req.session?.csrfToken,
            getTokenFromRequest: req => req.headers['x-csrf-token']?.toString(),
            storeTokenInState: (req, token) => { req.session.csrfToken = token; },
            size: 32,
        });
        app.get('/csrf-token', (req, res) => res.json({ token: csrf.generateToken(req) }));
        app.use(csrf.csrfSynchronisedProtection);
        // Test-only login stub. Real login credentials and authorization must
        // separately be verified by a full SillyTavern HTTP integration test.
        app.post('/api/users/login', (req, res) => {
            if (!['alice', 'bob'].includes(req.body?.handle)) return res.sendStatus(403);
            req.session.handle = req.body.handle;
            res.json({ handle: req.body.handle });
        });
        app.post('/api/users/logout', (req, res) => {
            req.session = null;
            res.sendStatus(204);
        });
        const router = express.Router();
        register(router);
        app.use('/api/plugins/miya-memory', router);
        server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        port = server.address().port;
    });
    afterEach(async () => {
        await new Promise(resolve => server.close(resolve));
        if (previous.enabled === undefined) delete process.env.MIYA_VISIT_IMPORT_ENABLED;
        else process.env.MIYA_VISIT_IMPORT_ENABLED = previous.enabled;
        if (previous.dir === undefined) delete process.env.MIYA_VISIT_DATA_DIR;
        else process.env.MIYA_VISIT_DATA_DIR = previous.dir;
        fs.rmSync(temp, { recursive: true, force: true });
    });

    test('requires both session and CSRF and allows authenticated upload + readback', async () => {
        const request = makeClient(port);
        const csrf = (await request('GET', '/csrf-token')).body.token;
        const beforeLogin = await request('POST', '/api/plugins/miya-memory/visits/import-v1',
            { events: [FIXTURE] }, csrf);
        expect(beforeLogin.status).toBe(403);
        const badLogin = await request('POST', '/api/users/login', { handle: 'alice' });
        expect(badLogin.status).toBe(403);
        expect((await request('POST', '/api/users/login', { handle: 'alice' }, csrf)).status).toBe(200);
        const tokenAfterLogin = (await request('GET', '/csrf-token')).body.token;
        const missingToken = await request('POST', '/api/plugins/miya-memory/visits/import-v1',
            { events: [FIXTURE] });
        expect(missingToken.status).toBe(403);
        const sent = await request('POST', '/api/plugins/miya-memory/visits/import-v1',
            { events: [FIXTURE] }, tokenAfterLogin);
        expect(sent.status).toBe(200);
        expect(sent.body).toMatchObject({ added: 1, duplicates: 0 });
        const repeat = await request('POST', '/api/plugins/miya-memory/visits/import-v1',
            { events: [FIXTURE] }, tokenAfterLogin);
        expect(repeat.body).toMatchObject({ added: 0, duplicates: 1 });
        const returned = await request('GET', '/api/plugins/miya-memory/visits/export-v1');
        expect(returned.status).toBe(200);
        expect(returned.body.events).toEqual([FIXTURE]);
        expect((await request('POST', '/api/users/logout', null, tokenAfterLogin)).status).toBe(204);
        expect((await request('GET', '/api/plugins/miya-memory/visits/export-v1')).status).toBe(403);
    });

    test('users with separate session cookies cannot read each other’s visit events', async () => {
        const alice = makeClient(port);
        const bob = makeClient(port);
        const aliceToken = (await alice('GET', '/csrf-token')).body.token;
        const bobToken = (await bob('GET', '/csrf-token')).body.token;
        expect((await alice('POST', '/api/users/login', { handle: 'alice' }, aliceToken)).status).toBe(200);
        expect((await bob('POST', '/api/users/login', { handle: 'bob' }, bobToken)).status).toBe(200);
        const aCsrf = (await alice('GET', '/csrf-token')).body.token;
        expect((await alice('POST', '/api/plugins/miya-memory/visits/import-v1',
            { events: [FIXTURE] }, aCsrf)).status).toBe(200);
        expect((await bob('GET', '/api/plugins/miya-memory/visits/export-v1')).body.events).toEqual([]);
        expect((await alice('GET', '/api/plugins/miya-memory/visits/export-v1')).body.events).toEqual([FIXTURE]);
    });
});
