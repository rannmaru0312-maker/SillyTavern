// A child-process fixture: real auth routes, synthetic accounts and isolated disk.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

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
