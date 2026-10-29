/* global globalThis */
import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pluginSource = fileURLToPath(new URL('../plugins/miya-memory/', import.meta.url));
const ROOT = '/api/plugins/miya-memory';
const PASSWORD_A = 'fictional-password-a';
const PASSWORD_B = 'fictional-password-b';

describe('MIYA memory V3: HTTP login, signed session and CSRF integration', () => {
    let fixtureRoot;
    let listener;
    let baseUrl;
    let storage;
    let clientA;
    let clientB;
    let originalDataRoot;
    let originalAccountsEnv;

    function saveCookies(jar, response) {
        for (const header of response.headers.getSetCookie()) {
            const pair = header.split(';', 1)[0];
            const separator = pair.indexOf('=');
            if (separator > 0) {
                jar.set(pair.slice(0, separator), pair.slice(separator + 1));
            }
        }
    }

    async function request(client, method, route, body, options = {}) {
        const headers = {};
        if (client?.cookies.size) {
            headers.cookie = [...client.cookies].map(([key, value]) => key + '=' + value).join('; ');
        }
        if (client?.csrf && !options.omitCsrf && !['GET', 'HEAD'].includes(method)) {
            headers['x-csrf-token'] = client.csrf;
        }
        if (body !== undefined) headers['content-type'] = 'application/json';
        const response = await fetch(baseUrl + route, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
        });
        if (client) saveCookies(client.cookies, response);
        const raw = await response.text();
        let payload;
        try { payload = JSON.parse(raw); } catch { payload = raw; }
        return { status: response.status, payload };
    }

    async function newClient() {
        const client = { cookies: new Map(), csrf: null };
        const token = await request(client, 'GET', '/csrf-token');
        expect(token.status).toBe(200);
        expect(typeof token.payload.token).toBe('string');
        client.csrf = token.payload.token;
        return client;
    }

    beforeAll(async () => {
        fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-http-auth-'));
        originalDataRoot = globalThis.DATA_ROOT;
        originalAccountsEnv = process.env.SILLYTAVERN_ENABLEUSERACCOUNTS;
        globalThis.DATA_ROOT = fixtureRoot;
        process.env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'true';

        const configFile = path.join(fixtureRoot, 'config.yaml');
        fs.writeFileSync(configFile, 'enableUserAccounts: true\n');
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(configFile);

        // Jest's ESM VM loader cannot link users.js and its re-exporting
        // users-public.js dependency concurrently; load them sequentially.
        const expressModule = await import('express');
        const cookieModule = await import('cookie-session');
        const csrfModule = await import('csrf-sync');
        const users = await import('../src/users.js');
        const loginModule = await import('../src/endpoints/users-public.js');
        const storageModule = await import('node-persist');
        storage = storageModule.default;
        await users.initUserStorage(fixtureRoot);

        for (const [handle, password] of [
            ['fictional_user_a', PASSWORD_A],
            ['fictional_user_b', PASSWORD_B],
        ]) {
            const salt = users.getPasswordSalt();
            await storage.setItem(users.toKey(handle), {
                handle,
                name: handle,
                created: Date.now(),
                enabled: true,
                admin: false,
                salt,
                password: users.getPasswordHash(password, salt),
            });
        }

        const isolatedPlugin = path.join(fixtureRoot, 'isolated-plugin');
        fs.mkdirSync(isolatedPlugin);
        for (const file of ['index.js', 'add-candidate-v3-api.js', 'add-decision-v3-api.js']) {
            fs.copyFileSync(path.join(pluginSource, file), path.join(isolatedPlugin, file));
        }
        const isolatedCore = path.join(isolatedPlugin, 'v3-core');
        fs.mkdirSync(isolatedCore);
        for (const entry of fs.readdirSync(path.join(pluginSource, 'v3-core'), { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.js')) {
                fs.copyFileSync(path.join(pluginSource, 'v3-core', entry.name), path.join(isolatedCore, entry.name));
            }
        }

        const express = expressModule.default;
        const app = express();
        app.use(express.json());
        app.use(cookieModule.default({
            name: 'miya-e2e-session',
            secret: 'fictional-local-test-cookie-secret-never-for-production',
            httpOnly: true,
            sameSite: 'lax',
        }));
        app.use(users.setUserDataMiddleware);

        const csrf = csrfModule.csrfSync({
            getTokenFromState: req => req.session?.csrfToken,
            getTokenFromRequest: req => req.headers['x-csrf-token']?.toString(),
            storeTokenInState: (req, token) => { req.session.csrfToken = token; },
            size: 32,
        });
        app.get('/csrf-token', (req, res) => res.json({ token: csrf.generateToken(req) }));
        app.use(csrf.csrfSynchronisedProtection);
        app.use('/api/users', loginModule.router);

        const router = express.Router();
        const requireFromFixture = createRequire(path.join(isolatedPlugin, 'test-loader.cjs'));
        await requireFromFixture('./index.js').init(router);
        app.use(ROOT, users.requireLoginMiddleware, router);

        listener = http.createServer(app);
        await new Promise((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = 'http://127.0.0.1:' + listener.address().port;
    }, 30000);

    afterAll(async () => {
        // Restore process-wide state even if closing the server or clearing
        // the temporary account database fails. Never let cleanup failures
        // silently preserve the test account mode or temporary data root.
        try {
            if (listener) {
                listener.closeAllConnections();
                await new Promise(resolve => listener.close(resolve));
            }
        } finally {
            try {
                if (storage) await storage.clear();
            } finally {
                try {
                    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
                } finally {
                    if (originalAccountsEnv === undefined) {
                        delete process.env.SILLYTAVERN_ENABLEUSERACCOUNTS;
                    } else {
                        process.env.SILLYTAVERN_ENABLEUSERACCOUNTS = originalAccountsEnv;
                    }
                    globalThis.DATA_ROOT = originalDataRoot;
                }
            }
        }
    }, 30000);

    afterEach(() => {
        if (fixtureRoot) {
            fs.rmSync(path.join(fixtureRoot, 'isolated-plugin', 'runtime-data'), {
                recursive: true,
                force: true,
            });
        }
    });

    test('unauthenticated HTTP requests ignore forged user IDs and return 403', async () => {
        const denied = await request(null, 'GET', ROOT + '/decisions-v3?userId=fictional_user_a');
        expect(denied.status).toBe(403);
        const deniedMemory = await request(null, 'GET', ROOT + '/character-memories?userId=fictional_user_a&characterId=fictional_character_a');
        expect(deniedMemory.status).toBe(403);
    });

    test('anonymous candidate POST with a valid CSRF token cannot write pending memory', async () => {
        const anonymous = await newClient();
        const denied = await request(anonymous, 'POST', ROOT + '/candidate-v3', {
            userId: 'fictional_user_a',
            characterId: 'fictional_character_a',
            text: 'Anonymous submission must not persist',
        });
        expect(denied.status).toBe(403);

        const authenticated = await newClient();
        expect((await request(authenticated, 'POST', '/api/users/login', {
            handle: 'fictional_user_a', password: PASSWORD_A,
        })).status).toBe(200);
        const pending = await request(authenticated, 'GET', ROOT + '/decisions-v3');
        expect(pending.status).toBe(200);
        expect(pending.payload.pending).toEqual([]);
    });

    test('real login rejects incorrect credentials and issues separate signed sessions', async () => {
        clientA = await newClient();
        clientB = await newClient();
        expect((await request(clientA, 'POST', '/api/users/login', {
            handle: 'fictional_user_a', password: 'incorrect-fictional-password',
        })).status).toBe(403);

        const aLogin = await request(clientA, 'POST', '/api/users/login', {
            handle: 'fictional_user_a', password: PASSWORD_A,
        });
        const bLogin = await request(clientB, 'POST', '/api/users/login', {
            handle: 'fictional_user_b', password: PASSWORD_B,
        });
        expect(aLogin.status).toBe(200);
        expect(bLogin.status).toBe(200);
        expect(aLogin.payload.handle).toBe('fictional_user_a');
        expect(bLogin.payload.handle).toBe('fictional_user_b');
        expect([...clientA.cookies.keys()].some(key => key.endsWith('.sig'))).toBe(true);
        expect([...clientB.cookies.keys()].some(key => key.endsWith('.sig'))).toBe(true);
    });

    test('user A cannot route a pending candidate or approved memory into user B', async () => {
        const a = await newClient();
        const b = await newClient();
        expect((await request(a, 'POST', '/api/users/login', {
            handle: 'fictional_user_a', password: PASSWORD_A,
        })).status).toBe(200);
        expect((await request(b, 'POST', '/api/users/login', {
            handle: 'fictional_user_b', password: PASSWORD_B,
        })).status).toBe(200);

        const created = await request(a, 'POST', ROOT + '/candidate-v3', {
            userId: 'fictional_user_b',
            characterId: 'fictional_character_a',
            text: 'Fictional private A HTTP preference',
        });
        expect(created.status).toBe(201);
        const id = created.payload.candidate.id;

        const asB = await request(b, 'GET', ROOT + '/decisions-v3?userId=fictional_user_a');
        expect(asB.status).toBe(200);
        expect(asB.payload.pending).toEqual([]);

        const hijack = await request(b, 'POST', ROOT + '/decision-v3', {
            userId: 'fictional_user_a', candidateId: id, decision: 'approve',
        });
        expect(hijack.status).toBe(404);

        const approval = await request(a, 'POST', ROOT + '/decision-v3', {
            candidateId: id, decision: 'approve',
        });
        expect(approval.status).toBe(200);

        const aMemories = await request(a, 'GET', ROOT + '/character-memories?characterId=fictional_character_a');
        const bMemories = await request(b, 'GET', ROOT + '/character-memories?characterId=fictional_character_a&userId=fictional_user_a');
        const otherCharacter = await request(a, 'GET', ROOT + '/character-memories?characterId=fictional_character_b');
        expect(aMemories.payload.memories.map(item => item.text)).toEqual(['Fictional private A HTTP preference']);
        expect(bMemories.payload.memories).toEqual([]);
        expect(otherCharacter.payload.memories).toEqual([]);
    });

    test('tampered signed session is rejected rather than trusting forged identity', async () => {
        const user = await newClient();
        expect((await request(user, 'POST', '/api/users/login', {
            handle: 'fictional_user_a', password: PASSWORD_A,
        })).status).toBe(200);
        const signature = [...user.cookies.keys()].find(key => key.endsWith('.sig'));
        expect(signature).toBeDefined();
        user.cookies.set(signature, 'tampered-local-test-signature');
        const response = await request(user, 'GET', ROOT + '/decisions-v3?userId=fictional_user_a');
        expect(response.status).toBe(403);
    });

    test('CSRF token from another authenticated session cannot create a candidate', async () => {
        const a = await newClient();
        const b = await newClient();
        expect((await request(a, 'POST', '/api/users/login', {
            handle: 'fictional_user_a', password: PASSWORD_A,
        })).status).toBe(200);
        expect((await request(b, 'POST', '/api/users/login', {
            handle: 'fictional_user_b', password: PASSWORD_B,
        })).status).toBe(200);
        expect(a.csrf).not.toBe(b.csrf);

        const originalToken = a.csrf;
        a.csrf = b.csrf;
        try {
            const denied = await request(a, 'POST', ROOT + '/candidate-v3', {
                characterId: 'fictional_character_a',
                text: 'Must not be saved with a different session CSRF token',
            });
            expect(denied.status).toBe(403);
        } finally {
            a.csrf = originalToken;
        }

        const pending = await request(a, 'GET', ROOT + '/decisions-v3');
        expect(pending.status).toBe(200);
        expect(pending.payload.pending).toEqual([]);
    });

    test('authenticated POST without CSRF token cannot create a candidate', async () => {
        const user = await newClient();
        expect((await request(user, 'POST', '/api/users/login', {
            handle: 'fictional_user_a', password: PASSWORD_A,
        })).status).toBe(200);
        const denied = await request(user, 'POST', ROOT + '/candidate-v3', {
            characterId: 'fictional_character_a', text: 'Must not be saved without CSRF',
        }, { omitCsrf: true });
        expect(denied.status).toBe(403);
        const pending = await request(user, 'GET', ROOT + '/decisions-v3');
        expect(pending.status).toBe(200);
        expect(pending.payload.pending).toEqual([]);
    });
});
