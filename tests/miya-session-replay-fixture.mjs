/* global globalThis */
// A child-process fixture: real auth routes, synthetic accounts and isolated disk.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const root = process.env.MIYA_SESSION_TEST_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('An isolated test root is required');
const dataRoot = path.join(root, 'data');
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
globalThis.DATA_ROOT = dataRoot;

const timeout = Number(process.env.MIYA_SESSION_TEST_TIMEOUT || -1);
const config = path.join(root, 'config.yaml');
if (!fs.existsSync(config)) {
    fs.writeFileSync(config, 'enableUserAccounts: true\nsessionTimeout: ' + timeout + '\n', { flag: 'wx', mode: 0o600 });
}
const util = await import('../src/util.js');
util.setConfigFilePath(config);
const users = await import('../src/users.js');
const publicRoutes = await import('../src/endpoints/users-public.js');
const privateRoutes = await import('../src/endpoints/users-private.js');
const storageModule = await import('node-persist');
const expressModule = await import('express');
const cookieModule = await import('cookie-session');
const csrfModule = await import('csrf-sync');
const storage = storageModule.default;
await users.initUserStorage(dataRoot);

const handle = 'fictional_account';
const salt = users.getPasswordSalt();
if (!await storage.getItem(users.toKey(handle))) {
    await storage.setItem(users.toKey(handle), {
        handle,
        name: 'Fictional Test Account',
        created: Date.now(),
        password: users.getPasswordHash('fictional-first-password', salt),
        salt,
        enabled: true,
        admin: false,
    });
}

// Fault injection and time travel exist only in this disposable child process.
const clock = Date.now.bind(Date);
Date.now = () => clock() + (fs.existsSync(path.join(root, 'clock.json'))
    ? JSON.parse(fs.readFileSync(path.join(root, 'clock.json'), 'utf8')) : 0);
for (const operation of ['getItem', 'removeItem', 'setItem']) {
    const original = storage[operation].bind(storage);
    storage[operation] = async (key, ...args) => {
        const control = path.join(root, 'fault.json');
        const fault = fs.existsSync(control) ? JSON.parse(fs.readFileSync(control, 'utf8')) : {};
        if (fault.operation === operation && key.startsWith(fault.prefix)) {
            if (fault.skip > 0) {
                fs.writeFileSync(control, JSON.stringify({ ...fault, skip: fault.skip - 1 }));
            } else {
                throw new Error('Injected storage failure');
            }
        }
        return original(key, ...args);
    };
}
const pluginSource = new URL('../plugins/miya-memory/', import.meta.url);
const isolatedPlugin = path.join(root, 'isolated-plugin');
fs.mkdirSync(path.join(isolatedPlugin, 'v3-core'), { recursive: true });
for (const file of ['index.js', 'add-candidate-v3-api.js', 'add-decision-v3-api.js']) {
    fs.copyFileSync(new URL(file, pluginSource), path.join(isolatedPlugin, file));
}
for (const entry of fs.readdirSync(new URL('v3-core/', pluginSource))) {
    if (entry.endsWith('.js')) fs.copyFileSync(new URL('v3-core/' + entry, pluginSource), path.join(isolatedPlugin, 'v3-core', entry));
}

const express = expressModule.default;
const app = express();
app.use(express.json());
app.use(cookieModule.default({
    name: 'miya-auth-replay-fixture',
    secret: 'only-an-isolated-throwaway-test-secret',
    sameSite: 'lax',
    httpOnly: true,
    maxAge: users.getSessionCookieAge(),
}));
// Test-only route synthesizes a correctly signed pre-migration cookie
// without a server-side session ID. It is never installed in production.
app.get('/__fixture/legacy-cookie', async (req, res) => {
    const user = await storage.getItem(users.toKey(handle));
    req.session.handle = handle;
    req.session.version = users.getAccountVersion(user);
    res.sendStatus(204);
});
app.use(users.setUserDataMiddleware);
const csrf = csrfModule.csrfSync({
    getTokenFromState: req => req.session?.csrfToken,
    getTokenFromRequest: req => req.headers['x-csrf-token']?.toString(),
    storeTokenInState: (req, token) => { req.session.csrfToken = token; },
    size: 32,
});
app.get('/csrf-token', (req, res) => res.json({ token: csrf.generateToken(req) }));
app.use(csrf.csrfSynchronisedProtection);
app.use('/api/users', publicRoutes.router);
app.use(users.requireLoginMiddleware);
app.use('/api/users', privateRoutes.router);
app.post('/api/ping', async (req, res) => {
    if (req.query.extend && req.session && !await users.touchAccountSession(req, res)) return;
    res.sendStatus(204);
});
app.get('/', (_req, res) => res.sendStatus(200));
const memoryRouter = express.Router();
const requireFixture = createRequire(path.join(isolatedPlugin, 'fixture-loader.cjs'));
await requireFixture('./index.js').init(memoryRouter);
app.use('/api/plugins/miya-memory', memoryRouter);

const server = http.createServer(app);
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
process.stdout.write('MIYA_SESSION_READY:' + server.address().port + '\n');
process.on('SIGTERM', () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
});
