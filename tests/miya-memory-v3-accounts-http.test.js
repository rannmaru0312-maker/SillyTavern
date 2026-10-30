import { afterEach, describe, expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureScript = fileURLToPath(new URL('./miya-memory-v3-http-fixture.mjs', import.meta.url));
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const ROOT = '/api/plugins/miya-memory';
let fixtureRoot;
let serverProcess;
let baseUrl;

function saveCookies(client, response) {
    for (const entry of response.headers.getSetCookie()) {
        const cookiePair = entry.split(';', 1)[0];
        const equalsAt = cookiePair.indexOf('=');
        if (equalsAt > 0) {
            client.cookies.set(cookiePair.slice(0, equalsAt), cookiePair.slice(equalsAt + 1));
        }
    }
}

async function request(client, method, route, body, options = {}) {
    const headers = {};
    if (client?.cookies?.size) {
        headers.cookie = [...client.cookies].map(([key, value]) => key + '=' + value).join('; ');
    }
    if (client?.csrf && !options.omitCsrf && !['GET', 'HEAD'].includes(method)) {
        headers['x-csrf-token'] = options.csrfToken || client.csrf;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(baseUrl + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
    });
    if (client) saveCookies(client, response);
    const raw = await response.text();
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        payload = raw;
    }
    return { status: response.status, payload };
}

async function newClient() {
    const client = { cookies: new Map(), csrf: null };
    const csrfResponse = await request(client, 'GET', '/csrf-token');
    expect(csrfResponse.status).toBe(200);
    expect(typeof csrfResponse.payload.token).toBe('string');
    client.csrf = csrfResponse.payload.token;
    return client;
}

async function startFixture(accountsEnabled) {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-account-http-'));
    let output = '';
    serverProcess = spawn(process.execPath, [fixtureScript], {
        cwd: projectRoot,
        env: {
            ...process.env,
            MIYA_HTTP_FIXTURE_ROOT: fixtureRoot,
            MIYA_HTTP_ACCOUNTS: String(accountsEnabled),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HTTP fixture startup timed out: ' + output.slice(-1600))), 20000);
        let ready = false;
        const fail = (error) => {
            if (!ready) {
                ready = true;
                clearTimeout(timeout);
                reject(error);
            }
        };
        serverProcess.stdout.on('data', (chunk) => {
            output += chunk.toString();
            const match = output.match(/MIYA_HTTP_READY:(\d+)/);
            if (match && !ready) {
                ready = true;
                clearTimeout(timeout);
                resolve(Number(match[1]));
            }
        });
        serverProcess.stderr.on('data', (chunk) => {
            output += chunk.toString();
        });
        serverProcess.once('error', fail);
        serverProcess.once('exit', (code, signal) => {
            fail(new Error('HTTP fixture exited before ready: ' + code + ' / ' + signal + '\n' + output.slice(-1600)));
        });
    });
    baseUrl = 'http://127.0.0.1:' + port;
}

afterEach(async () => {
    if (serverProcess) {
        if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
            serverProcess.kill('SIGTERM');
            await new Promise(resolve => {
                const timeout = setTimeout(() => {
                    serverProcess.kill('SIGKILL');
                    resolve();
                }, 2500);
                serverProcess.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }
        serverProcess = undefined;
    }
    if (fixtureRoot) {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
    }
    baseUrl = undefined;
});

describe('MIYA memory V3: live HTTP configuration boundaries', () => {
    test('accounts disabled: the DEFAULT_USER cannot read, queue or approve memories', async () => {
        await startFixture(false);
        const client = await newClient();
        const attempts = [
            ['GET', ROOT + '/decisions-v3', undefined],
            ['GET', ROOT + '/character-memories?characterId=fictional_character', undefined],
            ['POST', ROOT + '/candidate-v3', {
                userId: 'fictional_user_a',
                characterId: 'fictional_character',
                text: 'Never persist this fictional secret',
            }],
            ['POST', ROOT + '/decision-v3', {
                userId: 'fictional_user_a',
                candidateId: 'fictional-candidate',
                decision: 'approve',
            }],
        ];
        for (const [method, route, body] of attempts) {
            const result = await request(client, method, route, body);
            expect(result.status).toBe(403);
        }
        expect(fs.existsSync(path.join(fixtureRoot, 'isolated-plugin', 'runtime-data'))).toBe(false);
    }, 45000);

    test('accounts enabled: real login, cross-user isolation and decision CSRF rules', async () => {
        await startFixture(true);
        const anonymous = await newClient();
        expect((await request(anonymous, 'GET', ROOT + '/decisions-v3')).status).toBe(403);

        const clientA = await newClient();
        const clientB = await newClient();
        const loginA = await request(clientA, 'POST', '/api/users/login', {
            handle: 'fictional_user_a', password: 'fictional-password-a',
        });
        const loginB = await request(clientB, 'POST', '/api/users/login', {
            handle: 'fictional_user_b', password: 'fictional-password-b',
        });
        expect(loginA.status).toBe(200);
        expect(loginB.status).toBe(200);
        expect([...clientA.cookies.keys()].some(key => key.endsWith('.sig'))).toBe(true);
        expect([...clientB.cookies.keys()].some(key => key.endsWith('.sig'))).toBe(true);

        const created = await request(clientA, 'POST', ROOT + '/candidate-v3', {
            userId: 'fictional_user_b',
            characterId: 'fictional_character_a',
            text: 'Fictional private memory for A',
        });
        expect(created.status).toBe(201);
        const candidateId = created.payload.candidate.id;
        expect((await request(clientB, 'GET', ROOT + '/decisions-v3?userId=fictional_user_a')).payload.pending).toEqual([]);

        // Other sessions, including a forged request userId, cannot approve A's data.
        const crossUser = await request(clientB, 'POST', ROOT + '/decision-v3', {
            userId: 'fictional_user_a', candidateId, decision: 'approve',
        });
        expect(crossUser.status).toBe(404);

        // A valid account session still requires its own anti-CSRF token.
        const missing = await request(clientA, 'POST', ROOT + '/decision-v3', {
            candidateId, decision: 'approve',
        }, { omitCsrf: true });
        const otherToken = await request(clientA, 'POST', ROOT + '/decision-v3', {
            candidateId, decision: 'approve',
        }, { csrfToken: clientB.csrf });
        expect(missing.status).toBe(403);
        expect(otherToken.status).toBe(403);

        const before = await request(clientA, 'GET', ROOT + '/decisions-v3');
        expect(before.payload.pending.map(item => item.id)).toContain(candidateId);
        const notApproved = await request(clientA, 'GET', ROOT + '/character-memories?characterId=fictional_character_a');
        expect(notApproved.payload.memories).toEqual([]);

        const approved = await request(clientA, 'POST', ROOT + '/decision-v3', { candidateId, decision: 'approve' });
        expect(approved.status).toBe(200);
        const aMemory = await request(clientA, 'GET', ROOT + '/character-memories?characterId=fictional_character_a');
        const bMemory = await request(clientB, 'GET', ROOT + '/character-memories?characterId=fictional_character_a');
        expect(aMemory.payload.memories.map(item => item.text)).toEqual(['Fictional private memory for A']);
        expect(bMemory.payload.memories).toEqual([]);

        const signature = [...clientA.cookies.keys()].find(key => key.endsWith('.sig'));
        clientA.cookies.set(signature, 'tampered-signature');
        expect((await request(clientA, 'GET', ROOT + '/decisions-v3')).status).toBe(403);
    }, 45000);
});
