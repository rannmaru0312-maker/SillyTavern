import crypto from 'node:crypto';
import storage from 'node-persist';

const SESSION_KEY_PREFIX = 'auth-session:v1:';
const DEFAULT_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

function sessionKey(sessionId) {
    // Persist only the hash; the signed cookie holds the random secret.
    return SESSION_KEY_PREFIX + crypto.createHash('sha256').update(sessionId).digest('hex');
}

// node-persist sessions are single-process. Serialize mutations per session so
// an in-flight renewal cannot write back a record after logout deletes it.
const sessionOperations = new Map();
async function withSessionLock(sessionId, operation) {
    const key = sessionKey(sessionId);
    const previous = sessionOperations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    sessionOperations.set(key, current);
    try {
        return await current;
    } finally {
        if (sessionOperations.get(key) === current) sessionOperations.delete(key);
    }
}

async function readActiveRecord(key, handle) {
    const record = await storage.getItem(key);
    if (!record || record.handle !== handle || !Number.isSafeInteger(record.expiresAt)) return null;
    if (record.expiresAt <= Date.now()) {
        await storage.removeItem(key);
        return null;
    }
    return record;
}

/**
 * Start a new durable session only after authentication succeeds.
 * @param {import('express').Request} request Express request
 * @param {string} handle Authenticated account handle
 * @param {string} version Existing SillyTavern account version
 * @param {number|undefined} cookieAge Existing cookie maxAge (ms)
 */
export async function issueAccountSession(request, handle, version, cookieAge) {
    if (!request.session) throw new Error('Session is not available');
    const previous = request.session.sid;
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const age = cookieAge ?? DEFAULT_MAX_AGE_MS;
    // Browser-session cookies (sessionTimeout=0) still expire on browser close;
    // also bound server-side replay exposure to 400 days at most.
    if (!Number.isSafeInteger(age) || age <= 0) throw new Error('Invalid session expiration');
    await storage.setItem(sessionKey(sessionId), {
        handle,
        expiresAt: Date.now() + age,
    });
    request.session.sid = sessionId;
    request.session.handle = handle;
    request.session.version = version;
    if (typeof previous === 'string' && SESSION_ID_PATTERN.test(previous) && previous !== sessionId) {
        await withSessionLock(previous, () => storage.removeItem(sessionKey(previous)));
    }
}

/**
 * A signed cookie is not sufficient: its session must remain active in storage.
 * The server-side expiration applies even if an old cookie was copied.
 * Storage errors propagate so the HTTP boundary can deny access with 503.
 * @param {import('express').Request} request Express request
 * @param {string} handle Logged-in handle
 * @returns {Promise<boolean>}
 */
export async function isAccountSessionActive(request, handle) {
    const sessionId = request.session?.sid;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
    return withSessionLock(sessionId, async () => Boolean(await readActiveRecord(sessionKey(sessionId), handle)));
}

/**
 * Extend only a still-active session; never create a missing/revoked record.
 * @param {import('express').Request} request Express request
 * @param {string} handle Validated account handle
 * @param {number|undefined} cookieAge Cookie lifetime in ms; undefined means browser session
 * @returns {Promise<boolean>} Whether the session can be touched
 */
export async function extendAccountSession(request, handle, cookieAge) {
    const sessionId = request.session?.sid;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
    return withSessionLock(sessionId, async () => {
        const key = sessionKey(sessionId);
        const record = await readActiveRecord(key, handle);
        if (!record) return false;
        // Keep sessionTimeout=0 browser-close behavior and its existing server bound.
        if (cookieAge !== undefined) {
            if (!Number.isSafeInteger(cookieAge) || cookieAge <= 0) throw new Error('Invalid session expiration');
            await storage.setItem(key, { ...record, expiresAt: Math.max(record.expiresAt, Date.now() + cookieAge) });
        }
        return true;
    });
}

/**
 * Logout invalidates only this session; other devices remain logged in.
 * @param {import('express').Request} request Express request
 */
export async function revokeAccountSession(request) {
    const sessionId = request.session?.sid;
    if (typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)) {
        await withSessionLock(sessionId, () => storage.removeItem(sessionKey(sessionId)));
    }
}

/** Purge expired sessions without touching any user/password records. */
export async function pruneExpiredAccountSessions() {
    const keys = await storage.keys(entry => entry.key.startsWith(SESSION_KEY_PREFIX));
    for (const key of keys) {
        const record = await storage.getItem(key);
        if (!record || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now()) {
            await storage.removeItem(key);
        }
    }
}
