/**
 * Categorize provider/API stoppages without leaking response payloads or credentials.
 * No retries, network calls, spending, or agent execution here.
 * This produces actionable reporting metadata for a future approved dispatcher.
 */
const KNOWN = new Map([
    ['usage_limit_reached', 'usage-limit'],
    ['insufficient_quota', 'usage-limit'],
    ['billing_hard_limit_reached', 'billing-limit'],
    ['billing_not_active', 'billing-required'],
    ['provider_not_connected', 'connection-required'],
]);
const ACTION = new Map([
    ['usage-limit', 'Stop new work; report provider and verified usage limit. Resume only when quota is restored.'],
    ['billing-limit', 'Stop new work; request explicit owner approval before any extra spending.'],
    ['billing-required', 'Do not purchase a plan or activate billing; ask owner to decide.'],
    ['connection-required', 'Stop dispatch; request authorized provider connection, no token sharing.'],
    ['rate-limited', 'Do not repeatedly retry; check documented Retry-After or provider limits.'],
    ['permission-denied', 'Do not bypass permission checks; ask for the minimum required authorization.'],
    ['resource-disabled', 'Use draft PR/JSON handoffs instead of GitHub Issues; do not bypass policy.'],
    ['temporary-network-failure', 'Pause work and report the network fault before retrying.'],
    ['unverified', 'Stop and ask for verified evidence; do not assume a quota or billing issue.'],
]);
export function classifyDispatchStop(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Invalid dispatch stop evidence');
    }
    const { provider, status, code } = input;
    if (!['codex', 'copilot', 'work', 'github-actions', 'github'].includes(provider)
        || !Number.isInteger(status) || status < 0 || status > 599
        || typeof code !== 'string' || code.length > 70
        || !/^[a-z0-9_-]*$/.test(code)) {
        throw new Error('Invalid dispatch stop evidence');
    }
    const kind = KNOWN.get(code) ?? (
        status === 429 ? 'rate-limited'
            : status === 403 ? 'permission-denied'
                : status === 410 ? 'resource-disabled'
                    : status === 502 || status === 503 || status === 504 ? 'temporary-network-failure'
                        : 'unverified'
    );
    return {
        provider,
        category: kind,
        status,
        providerCode: code || 'not-provided',
        automaticDispatchStopped: true,
        extraChargeApproved: false,
        requiresUserAction: kind !== 'temporary-network-failure',
        causeVerified: KNOWN.has(code),
        explanation: ACTION.get(kind),
    };
}
