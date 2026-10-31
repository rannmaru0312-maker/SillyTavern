/* eslint-disable playwright/no-standalone-expect -- Jest callbacks are test blocks. */
import { afterEach, describe, expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./miya-session-replay-fixture.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));
let fixtureRoot;
let child;
let baseUrl;

async function start(timeoutSeconds = -1, reuseRoot = false) {
    if (!reuseRoot || !fixtureRoot) {
        fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-session-replay-'));
    }
    child = spawn(process.execPath, [script], {
        cwd,
        env: {
            ...process.env,
            MIYA_SESSION_TEST_ROOT: fixtureRoot,
            MIYA_SESSION_TEST_TIMEOUT: String(timeoutSeconds),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const port = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            fail(new Error('Fixture start timed out:\n' + output.slice(-1800)));
        }, 20000);
        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        child.stdout.on('data', chunk => {
            output += chunk.toString();
            const match = output.match(/MIYA_SESSION_READY:(\d+)/);
            if (!settled && match) {
                settled = true;
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        child.once('error', fail);
        child.once('exit', (code, signal) => fail(new Error('Fixture exited: ' + code + '/' + signal + '\n' + output.slice(-1800))));
    });
    baseUrl = 'http://127.0.0.1:' + port;
}

function newJar() {
    return { cookies: new Map(), csrf: null };
}

function saveCookies(jar, response) {
    for (const header of response.headers.getSetCookie()) {
        const entry = header.split(';', 1)[0];
        const index = entry.indexOf('=');
        if (index > 0) {
            jar.cookies.set(entry.slice(0, index), entry.slice(index + 1));
        }
    }
}

async function send(jar, method, endpoint, body, options = {}) {
    const headers = {};
    if (jar.cookies.size) {
        headers.cookie = [...jar.cookies].map(([key, value]) => key + '=' + value).join('; ');
    }
    if (jar.csrf && !options.omitCsrf && method !== 'GET') {
        headers['x-csrf-token'] = jar.csrf;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const result = await fetch(baseUrl + endpoint, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
    });
    saveCookies(jar, result);
    const raw = await result.text();
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        payload = raw;
    }
    return { status: result.status, payload, setCookies: result.headers.getSetCookie() };
}

async function openJar() {
    const jar = newJar();
    const response = await send(jar, 'GET', '/csrf-token');
    expect(response.status).toBe(200);
    jar.csrf = response.payload.token;
    return jar;
}

async function login(jar, password = 'fictional-first-password') {
    return send(jar, 'POST', '/api/users/login', {
        handle: 'fictional_account',
        password,
    });
}

function signedCookieSnapshot(jar) {
    const snapshot = newJar();
    snapshot.cookies = new Map(jar.cookies);
    snapshot.csrf = jar.csrf;
    expect([...snapshot.cookies.keys()].some(name => name.endsWith('.sig'))).toBe(true);
    return snapshot;
}

async function stopFixture() {
    if (child) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await new Promise(resolve => {
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    resolve();
                }, 2500);
                child.once('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        child = undefined;
    }
}

afterEach(async () => {
    await stopFixture();
    if (fixtureRoot) {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
    }
    baseUrl = undefined;
});

describe('account sessions: live HTTP replay and expiry', () => {
    test.each([
        ['session read', 'getItem', 'auth-session:v1:', false],
        ['account read', 'getItem', 'user:', false],
        ['expired session deletion', 'removeItem', 'auth-session:v1:', true],
    ])('%s failure denies memory access, survives and recovers', async (_label, operation, prefix, expire) => {
        await start(60);
        const jar = await openJar();
        expect((await login(jar)).status).toBe(200);
        const memoryRoot = '/api/plugins/miya-memory';
        const created = await send(jar, 'POST', memoryRoot + '/candidate-v3', {
            characterId: 'fictional_character', text: 'Fictional private memory',
        });
        expect(created.status).toBe(201);
        expect((await send(jar, 'POST', memoryRoot + '/decision-v3', {
            candidateId: created.payload.candidate.id, decision: 'approve',
        })).status).toBe(200);
        const snapshot = signedCookieSnapshot(jar);
        if (expire) fs.writeFileSync(path.join(fixtureRoot, 'clock.json'), JSON.stringify(61000));
        fs.writeFileSync(path.join(fixtureRoot, 'fault.json'), JSON.stringify({ operation, prefix }));
        for (const endpoint of ['/api/users/me', '/api/plugins/miya-memory/character-memories?characterId=fictional_character&userId=fictional_other']) {
            const result = await send(jar, 'GET', endpoint);
            expect(result.status).toBe(503);
            expect(result.payload).toBe('Service Unavailable');
        }
        expect(child.exitCode).toBeNull();
        fs.unlinkSync(path.join(fixtureRoot, 'fault.json'));
        expect((await send(snapshot, 'GET', '/api/users/me')).status).toBe(expire ? 403 : 200);
        const fresh = await openJar();
        expect((await login(fresh)).status).toBe(200);
        const restored = await send(fresh, 'GET', memoryRoot + '/character-memories?characterId=fictional_character');
        expect(restored.status).toBe(200);
        expect(restored.payload.memories.map(item => item.text)).toEqual(['Fictional private memory']);
    }, 45000);

    test.each([['POST', '/api/ping?extend=1'], ['GET', '/']])('%s %s extends both session lifetimes', async (method, endpoint) => {
        await start(60);
        const jar = await openJar();
        expect((await login(jar)).status).toBe(200);
        fs.writeFileSync(path.join(fixtureRoot, 'clock.json'), JSON.stringify(30000));
        const extended = await send(jar, method, endpoint);
        expect(extended.status).toBe(method === 'POST' ? 204 : 200);
        expect(extended.setCookies.some(cookie => cookie.includes('expires='))).toBe(true);
        fs.writeFileSync(path.join(fixtureRoot, 'clock.json'), JSON.stringify(61000));
        expect((await send(jar, 'GET', '/api/users/me')).status).toBe(200);
        fs.writeFileSync(path.join(fixtureRoot, 'clock.json'), JSON.stringify(91000));
        expect((await send(jar, 'GET', '/api/users/me')).status).toBe(403);
    }, 45000);

    test('logout and expiration cannot be undone by extension', async () => {
        await start(60);
        const jar = await openJar();
        expect((await login(jar)).status).toBe(200);
        const revoked = signedCookieSnapshot(jar);
        expect((await send(jar, 'POST', '/api/users/logout')).status).toBe(204);
        expect((await send(revoked, 'POST', '/api/ping?extend=1')).status).toBe(403);
        const fresh = await openJar();
        expect((await login(fresh)).status).toBe(200);
        const expired = signedCookieSnapshot(fresh);
        fs.writeFileSync(path.join(fixtureRoot, 'clock.json'), JSON.stringify(61000));
        expect((await send(fresh, 'POST', '/api/ping?extend=1')).status).toBe(403);
        expect((await send(expired, 'GET', '/api/users/me')).status).toBe(403);
    }, 45000);

    test.each([['getItem', 1], ['setItem', 0]])('extension %s failure returns 503 without renewing cookie and recovers', async (operation, skip) => {
        await start(60);
        const jar = await openJar();
        expect((await login(jar)).status).toBe(200);
        fs.writeFileSync(path.join(fixtureRoot, 'clock.json'), JSON.stringify(30000));
        fs.writeFileSync(path.join(fixtureRoot, 'fault.json'), JSON.stringify({ operation, prefix: 'auth-session:v1:', skip }));
        const failed = await send(jar, 'POST', '/api/ping?extend=1');
        expect(failed.status).toBe(503);
        expect(failed.setCookies).toEqual([]);
        expect(child.exitCode).toBeNull();
        fs.unlinkSync(path.join(fixtureRoot, 'fault.json'));
        expect((await send(jar, 'POST', '/api/ping?extend=1')).status).toBe(204);
        fs.writeFileSync(path.join(fixtureRoot, 'clock.json'), JSON.stringify(61000));
        expect((await send(jar, 'GET', '/api/users/me')).status).toBe(200);
    }, 45000);

    test('sessionTimeout=0 preserves browser-session cookies and logout revocation', async () => {
        await start(0);
        const jar = await openJar();
        const loggedIn = await login(jar);
        expect(loggedIn.status).toBe(200);
        expect(loggedIn.setCookies.every(cookie => !/expires=|max-age=/i.test(cookie))).toBe(true);
        fs.writeFileSync(path.join(fixtureRoot, 'clock.json'), JSON.stringify(86400000));
        const extended = await send(jar, 'POST', '/api/ping?extend=1');
        expect(extended.status).toBe(204);
        expect(extended.setCookies.every(cookie => !/expires=|max-age=/i.test(cookie))).toBe(true);
        expect((await send(jar, 'GET', '/api/users/me')).status).toBe(200);
        const snapshot = signedCookieSnapshot(jar);
        expect((await send(jar, 'POST', '/api/users/logout')).status).toBe(204);
        expect((await send(snapshot, 'POST', '/api/ping?extend=1')).status).toBe(403);
    }, 45000);

    test('logout revokes only this device; replayed signed cookie cannot read private data', async () => {
        await start();
        const first = await openJar();
        const second = await openJar();
        expect((await login(first)).status).toBe(200);
        expect((await login(second)).status).toBe(200);
        const stolenBeforeLogout = signedCookieSnapshot(first);

        expect((await send(first, 'GET', '/api/users/me')).status).toBe(200);
        expect((await send(second, 'GET', '/api/users/me')).status).toBe(200);
        expect((await send(first, 'POST', '/api/users/logout')).status).toBe(204);

        expect((await send(stolenBeforeLogout, 'GET', '/api/users/me')).status).toBe(403);
        // Another account session of the same person remains usable.
        expect((await send(second, 'GET', '/api/users/me')).status).toBe(200);

        const newLogin = await openJar();
        expect((await login(newLogin)).status).toBe(200);
        expect((await send(newLogin, 'GET', '/api/users/me')).status).toBe(200);
        expect((await send(stolenBeforeLogout, 'GET', '/api/users/me')).status).toBe(403);
    }, 45000);

    test('revocation persists across a server restart; another device remains logged in', async () => {
        await start();
        const loggedOut = await openJar();
        const stillValid = await openJar();
        expect((await login(loggedOut)).status).toBe(200);
        expect((await login(stillValid)).status).toBe(200);
        const stolenCookie = signedCookieSnapshot(loggedOut);
        expect((await send(loggedOut, 'POST', '/api/users/logout')).status).toBe(204);

        await stopFixture();
        await start(-1, true);
        expect((await send(stolenCookie, 'GET', '/api/users/me')).status).toBe(403);
        expect((await send(stillValid, 'GET', '/api/users/me')).status).toBe(200);
    }, 45000);

    test('legacy signed cookies without a server-backed session ID must log in again', async () => {
        await start();
        const browser = await openJar();
        expect((await send(browser, 'GET', '/__fixture/legacy-cookie')).status).toBe(204);
        const oldCookie = signedCookieSnapshot(browser);
        expect((await send(oldCookie, 'GET', '/api/users/me')).status).toBe(403);
        const fresh = await openJar();
        expect((await login(fresh)).status).toBe(200);
        expect((await send(fresh, 'GET', '/api/users/me')).status).toBe(200);
    }, 45000);

    test('server-side expiration rejects a previously signed cookie', async () => {
        await start(1);
        const jar = await openJar();
        expect((await login(jar)).status).toBe(200);
        const snapshot = signedCookieSnapshot(jar);
        expect((await send(jar, 'GET', '/api/users/me')).status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 1250));
        expect((await send(snapshot, 'GET', '/api/users/me')).status).toBe(403);
        const fresh = await openJar();
        expect((await login(fresh)).status).toBe(200);
        expect((await send(fresh, 'GET', '/api/users/me')).status).toBe(200);
    }, 45000);

    test('password change preserves current session while invalidating old signed snapshots', async () => {
        await start();
        const current = await openJar();
        const other = await openJar();
        expect((await login(current)).status).toBe(200);
        expect((await login(other)).status).toBe(200);
        const savedOldCookie = signedCookieSnapshot(current);

        expect((await send(current, 'POST', '/api/users/change-password', {
            handle: 'fictional_account',
            oldPassword: 'fictional-first-password',
            newPassword: 'fictional-updated-password',
        })).status).toBe(204);

        expect((await send(current, 'GET', '/api/users/me')).status).toBe(200);
        expect((await send(savedOldCookie, 'GET', '/api/users/me')).status).toBe(403);
        expect((await send(other, 'GET', '/api/users/me')).status).toBe(403);

        const fresh = await openJar();
        expect((await login(fresh, 'fictional-first-password')).status).toBe(403);
        expect((await login(fresh, 'fictional-updated-password')).status).toBe(200);
        expect((await send(fresh, 'GET', '/api/users/me')).status).toBe(200);
    }, 45000);
});
