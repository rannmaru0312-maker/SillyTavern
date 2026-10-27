import { evaluateLoop } from './continuous-loop-policy.mjs';

// Adapter for the existing GitHub PR-comment Codex integration.
// The caller submits the prepared text using an authenticated GitHub connector.
// No token handling, HTTP requests, process spawn, or paid API usage here.
const SHA = /^[a-f0-9]{40}$/;
// Fixed, reviewed task templates only; never interpolate untrusted issue or review text.
const TASKS = Object.freeze({
    'fix-test-isolation': 'Fix the approved test isolation regression in this development PR.',
    'add-regression-tests': 'Add isolated regression tests for the approved development change.',
});
export function prepareCodexComment({ gate, sourcePr, taskId, workBranch }) {
    const result = evaluateLoop(gate);
    if (!result.mayDispatch) return { ok: false, reason: result.reason };
    if (!Number.isSafeInteger(sourcePr) || sourcePr < 1
        || typeof workBranch !== 'string' || !/^miya-ai-[a-z0-9-]{1,60}$/.test(workBranch)
        || typeof taskId !== 'string' || !Object.hasOwn(TASKS, taskId)) {
        return { ok: false, reason: 'invalid-dispatch-input' };
    }
    return {
        ok: true,
        prNumber: sourcePr,
        idempotencyKey: `codex:${sourcePr}:${gate.headSha}`,
        comment: `@codex ${TASKS[taskId]}\n\nMIYA handoff: source PR #${sourcePr}, verified SHA ${gate.headSha}, target branch ${workBranch}. Development changes only; no merge, deployment, release modification, secrets, paid usage, or production access. On environment or quota failure report the blocker without retrying.`,
    };
}

export function classifyCodexReply({ requestSha, currentSha, text }) {
    if (!SHA.test(requestSha) || !SHA.test(currentSha) || requestSha !== currentSha) {
        return { state: 'blocked', reason: 'stale-request' };
    }
    if (typeof text !== 'string' || text.length > 10000) return { state: 'unknown', reason: 'invalid-reply' };
    if (/To use Codex here,\s*\[?create an environment for this repo/i.test(text)) {
        return { state: 'blocked', reason: 'environment-not-recognized' };
    }
    if (/usage limit|quota exceeded|rate limit|insufficient.quota/i.test(text)) {
        return { state: 'blocked', reason: 'provider-limit' };
    }
    // Bot acknowledgement is not implementation evidence. Always verify a new
    // commit on the intended development PR and its checks independently.
    return { state: 'unverified', reason: 'must-verify-commit-and-ci' };
}
