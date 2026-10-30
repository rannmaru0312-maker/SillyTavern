// Isolated child-process fixture for MIYA HTTP authentication integration tests.
// Only JavaScript is copied from the plugin; runtime data stays under MIYA_HTTP_FIXTURE_ROOT.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const fixtureRoot = process.env.MIYA_HTTP_FIXTURE_ROOT;
const accountsEnabled = process.env.MIYA_HTTP_ACCOUNTS === 'true';
if (!fixtureRoot || !fs.statSync(fixtureRoot).isDirectory()) {
    throw new Error('An isolated fixture root is required');
}
const dataRoot = path.join(fixtureRoot, 'account-store');
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
globalThis.DATA_ROOT = dataRoot;
process.env.SILLYTAVERN_ENABLEUSERACCOUNTS = String(accountsEnabled);

const configFile = path.join(fixtureRoot, 'config.yaml');
fs.writeFileSync(configFile, 'enableUserAccounts: ' + accountsEnabled + '\n', { flag: 'wx', mode: 0o600 });
const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(configFile);

const expressModule = await import('express');
const cookieModule = await import('cookie-session');
const csrfModule = await import('csrf-sync');
const users = await import('../src/users.js');
const loginModule = await import('../src/endpoints/users-public.js');
const persistModule = await import('node-persist');

await users.initUserStorage(dataRoot);
const storage = persistModule.default;
if (accountsEnabled) {
    for (const [handle, password] of [
        ['fictional_user_a', 'fictional-password-a'],
        ['fictional_user_b', 'fictional-password-b'],
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
}

// Plugin storage paths are relative to this source directory, so copy ONLY
// JavaScript into the disposable fixture to avoid real runtime-data access.
const pluginSource = new URL('../plugins/miya-memory/', import.meta.url);
const isolatedPlugin = path.join(fixtureRoot, 'isolated-plugin');
const isolatedCore = path.join(isolatedPlugin, 'v3-core');
fs.mkdirSync(isolatedCore, { recursive: true, mode: 0o700 });
for (const file of ['index.js', 'add-candidate-v3-api.js', 'add-decision-v3-api.js']) {
    fs.copyFileSync(new URL(file, pluginSource), path.join(isolatedPlugin, file));
}
const coreSource = new URL('v3-core/', pluginSource);
for (const entry of fs.readdirSync(coreSource, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
        fs.copyFileSync(new URL(entry.name, coreSource), path.join(isolatedCore, entry.name));
    }
}

const express = expressModule.default;
const app = express();
app.use(express.json());
app.use(cookieModule.default({
    name: 'miya-http-test-session',
    secret: 'fictional-test-secret-only-not-for-production',
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
const requireFixture = createRequire(path.join(isolatedPlugin, 'fixture-loader.cjs'));
await requireFixture('./index.js').init(router);
app.use('/api/plugins/miya-memory', users.requireLoginMiddleware, router);

const server = http.createServer(app);
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
// Prefix allows the Jest parent to distinguish this line from other logs.
process.stdout.write('MIYA_HTTP_READY:' + server.address().port + '\n');
process.on('SIGTERM', () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
});
