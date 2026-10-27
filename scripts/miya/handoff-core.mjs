/**
 * MIYA safe handoff protocol (v1). This module is intentionally pure.
 * It DOES NOT launch agents, make requests, use credentials, or write files.
 * GitHub PRs and SHA-verified checks serve as durable human-auditable handoffs.
 */
const ROLES = new Set(['miya-planner', 'codex-implementer', 'ci-verifier', 'work-reviewer', 'human-owner']);
const STATES = new Set(['ready', 'implementing', 'review', 'blocked', 'done']);
const KINDS = new Set(['implementation', 'unit-test', 'security-review', 'documentation']);
const ALLOWED_TOP = new Set(['schemaVersion', 'id', 'repository', 'baseBranch', 'title', 'kind', 'priority', 'source', 'handoff', 'state', 'dependsOn', 'acceptance', 'gates']);
const ALLOWED_SOURCE = new Set(['prNumber', 'headSha']);
const ALLOWED_HANDOFF = new Set(['from', 'to']);
const ALLOWED_GATES = new Set(['agentDispatchEnabled', 'paidBudgetUsd', 'productionAccessEnabled', 'autoMergeEnabled', 'humanApprovalRequired']);
const idPattern = /^MIYA-AUTO-[0-9]{3,6}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const isRecord = item => item !== null && typeof item === 'object' && !Array.isArray(item);
const exactKeys = (obj, allowed) => [...Object.keys(obj)].every(key => allowed.has(key))
    && [...allowed].every(key => Object.hasOwn(obj, key));
const safeText = (item, max) => typeof item === 'string' && item.length > 0 && item.length <= max
    && !/[\u0000-\u001f\u007f]/.test(item);

/**
 * Validate an untrusted handoff record. Fails closed on unknown fields or unsafe flags.
 * A valid record is data only and never authorizes any agent action.
 */
export function validateHandoff(ticket) {
    if (!isRecord(ticket) || !exactKeys(ticket, ALLOWED_TOP)
        || ticket.schemaVersion !== 1
        || ticket.repository !== 'rannmaru0312-maker/SillyTavern'
        || ticket.baseBranch !== 'miya-ai-dev'
        || !idPattern.test(ticket.id)
        || !safeText(ticket.title, 100)
        || !KINDS.has(ticket.kind)
        || !Number.isInteger(ticket.priority) || ticket.priority < 0 || ticket.priority > 100
        || !isRecord(ticket.source) || !exactKeys(ticket.source, ALLOWED_SOURCE)
        || !Number.isInteger(ticket.source.prNumber) || ticket.source.prNumber < 1
        || !shaPattern.test(ticket.source.headSha)
        || !isRecord(ticket.handoff) || !exactKeys(ticket.handoff, ALLOWED_HANDOFF)
        || !ROLES.has(ticket.handoff.from) || !ROLES.has(ticket.handoff.to)
        || !STATES.has(ticket.state)
        || !Array.isArray(ticket.dependsOn) || ticket.dependsOn.length > 16
        || !ticket.dependsOn.every(id => typeof id === 'string' && idPattern.test(id))
        || new Set(ticket.dependsOn).size !== ticket.dependsOn.length
        || ticket.dependsOn.includes(ticket.id)
        || !Array.isArray(ticket.acceptance) || ticket.acceptance.length < 1
        || ticket.acceptance.length > 10 || !ticket.acceptance.every(text => safeText(text, 160))
        || !isRecord(ticket.gates) || !exactKeys(ticket.gates, ALLOWED_GATES)
        || ticket.gates.agentDispatchEnabled !== false
        || ticket.gates.paidBudgetUsd !== 0
        || ticket.gates.productionAccessEnabled !== false
        || ticket.gates.autoMergeEnabled !== false
        || ticket.gates.humanApprovalRequired !== true) {
        throw new Error('Invalid or unsafe MIYA handoff record');
    }
    return true;
}

/**
 * Deterministically select at most one eligible handoff proposal.
 * Never dispatches it. All records must be validated before selection.
 */
export function planNextHandoff(tickets) {
    if (!Array.isArray(tickets) || tickets.length > 100) {
        throw new Error('Invalid handoff collection');
    }
    const ids = new Set();
    for (const item of tickets) {
        validateHandoff(item);
        if (ids.has(item.id)) throw new Error('Duplicate handoff ID');
        ids.add(item.id);
    }
    for (const ticket of tickets) {
        if (ticket.dependsOn.some(id => !ids.has(id))) {
            throw new Error('Handoff depends on missing task');
        }
    }
    const active = tickets.filter(ticket => ticket.state === 'implementing' || ticket.state === 'review');
    if (active.length > 1) throw new Error('More than one active handoff');
    const ready = active.length ? [] : tickets
        .filter(ticket => ticket.state === 'ready'
            && ticket.dependsOn.every(id => tickets.find(item => item.id === id).state === 'done'))
        .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    const choice = ready[0] ?? null;
    return {
        mode: 'handoff-proposal-only',
        activeTaskId: active[0]?.id ?? null,
        nextTaskId: choice?.id ?? null,
        targetRole: choice?.handoff.to ?? null,
        sourcePrNumber: choice?.source.prNumber ?? null,
        requiredSourceSha: choice?.source.headSha ?? null,
        humanApprovalRequired: true,
        agentLaunched: false,
        issueAssigned: false,
        changesPushed: false,
        paidBudgetUsd: 0,
    };
}

/** Offline transition advice; caller must separately verify PR/CI evidence. */
export function allowedNextStates(state) {
    if (!STATES.has(state)) throw new Error('Unknown handoff state');
    return Object.freeze({
        ready: ['implementing', 'blocked'],
        implementing: ['review', 'blocked'],
        review: ['done', 'blocked'],
        blocked: ['ready'],
        done: [],
    }[state]);
}
