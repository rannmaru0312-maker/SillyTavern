// Optional, fail-closed prototype. NOT enabled in production by default.
// Loaded after SillyTavern's session, user, login and CSRF middlewares.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const validUser = /^[A-Za-z0-9_-]{1,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedFields = new Set(['event_id', 'place_id', 'place_name', 'kind', 'detected_at', 'confirmed_at', 'source', 'schema_version']);
const enabled = () => process.env.MIYA_VISIT_IMPORT_ENABLED === '1' &&
    typeof process.env.MIYA_VISIT_DATA_DIR === 'string' &&
    path.isAbsolute(process.env.MIYA_VISIT_DATA_DIR);

function dateIsISO(value) {
    if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
    return !Number.isNaN(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function normalizeEvent(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !allowedFields.has(key)) ||
        !uuid.test(item.event_id || '') || !uuid.test(item.place_id || '') ||
        typeof item.place_name !== 'string' || item.place_name.trim().length < 1 ||
        item.place_name.length > 100 || !['entry', 'exit'].includes(item.kind) ||
        !dateIsISO(item.detected_at) ||
        !(item.confirmed_at == null || dateIsISO(item.confirmed_at)) ||
        item.source !== 'ios_geofence' || item.schema_version !== 1) return null;
    return {
        event_id: item.event_id.toLowerCase(),
        place_id: item.place_id.toLowerCase(),
        place_name: item.place_name.trim(),
        kind: item.kind,
        detected_at: item.detected_at,
        confirmed_at: item.confirmed_at ?? null,
        source: 'ios_geofence',
        schema_version: 1,
    };
}

function authenticatedUser(req) {
    const handle = req.user?.profile?.handle;
    // Explicit session binding excludes the anonymous/default-user fallback.
    return (typeof handle === 'string' && validUser.test(handle) &&
        req.session?.handle === handle && req.user.profile.enabled !== false) ? handle : null;
}

function storagePath(handle) {
    const root = process.env.MIYA_VISIT_DATA_DIR;
    if (!enabled() || !validUser.test(handle)) throw new Error('Visit storage not configured');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.statSync(root).isDirectory()) throw new Error('Invalid visit storage directory');
    return path.join(root, handle + '.json');
}

function readStore(handle) {
    const file = storagePath(handle);
    if (!fs.existsSync(file)) return { version: 1, events: [] };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.events) || value.events.length > 5000) {
        throw new Error('Invalid visit storage');
    }
    return value;
}

function writeStore(handle, data) {
    const file = storagePath(handle);
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(tmp, file);
    } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
}

function register(router) {
    router.post('/visits/import-v1', (req, res) => {
        if (!enabled()) return res.status(404).json({ error: 'Feature not enabled' });
        const handle = authenticatedUser(req);
        if (!handle) return res.status(403).json({ error: 'Authenticated account required' });
        if (!Array.isArray(req.body?.events) ||
            req.body.events.length < 1 || req.body.events.length > 20 ||
            JSON.stringify(req.body).length > 32768) {
            return res.status(400).json({ error: 'Invalid batch' });
        }
        const events = req.body.events.map(normalizeEvent);
        if (events.some(value => !value)) return res.status(400).json({ error: 'Invalid event' });
        const seen = new Map();
        for (const item of events) {
            const previous = seen.get(item.event_id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
                return res.status(409).json({ error: 'Conflicting event ID' });
            }
            seen.set(item.event_id, item);
        }
        try {
            const store = readStore(handle);
            const byId = new Map(store.events.map(e => [e.event_id, e]));
            let added = 0;
            for (const item of seen.values()) {
                const old = byId.get(item.event_id);
                if (old && JSON.stringify(old) !== JSON.stringify(item)) {
                    return res.status(409).json({ error: 'Conflicting event ID' });
                }
                if (!old) { byId.set(item.event_id, item); added++; }
            }
            if (byId.size > 5000) return res.status(409).json({ error: 'Per-account event limit' });
            if (added) writeStore(handle, { version: 1, events: [...byId.values()] });
            return res.status(200).json({ success: true, added, duplicates: seen.size - added });
        } catch {
            return res.status(500).json({ error: 'Visit storage unavailable' });
        }
    });

    router.get('/visits/export-v1', (req, res) => {
        if (!enabled()) return res.status(404).json({ error: 'Feature not enabled' });
        const handle = authenticatedUser(req);
        if (!handle) return res.status(403).json({ error: 'Authenticated account required' });
        try {
            const store = readStore(handle);
            res.set?.('Cache-Control', 'no-store');
            return res.json({ version: 1, events: store.events });
        } catch {
            return res.status(500).json({ error: 'Visit storage unavailable' });
        }
    });
}
module.exports = { register, normalizeEvent };
