/**
 * Fail-closed transition policy for the MIYA continuous AI development loop.
 * This is a pure decision function: it never calls an AI, GitHub, or the network.
 * The scheduler must independently fetch trusted provider state before dispatch.
 */
const SHA = /^[a-f0-9]{40}$/;
const REQUIRED = ['MIYA AI Development Check', '✅ Pull Request Checks'];
const stop = (phase, reason) => ({ phase, reason, mayDispatch: false });

function inspectCore(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return stop('blocked', 'invalid-input');
    const { baseBranch, headSha, checks, review, activeJobs, lastDispatchedSha, paidBudgetUsd, productionAccess, autoMerge } = input;
    if (baseBranch !== 'miya-ai-dev' || typeof headSha !== 'string' || !SHA.test(headSha)) {
        return stop('blocked', 'invalid-target');
    }
    if (paidBudgetUsd !== 0 || productionAccess !== false || autoMerge !== false) {
        return stop('blocked', 'unsafe-permissions');
    }
    if (!Array.isArray(checks) || !Array.isArray(REQUIRED) || !Number.isInteger(activeJobs) || activeJobs < 0) {
        return stop('blocked', 'invalid-evidence');
    }
    const relevant = REQUIRED.map(name => checks.filter(check => check && check.name === name));
    if (relevant.some(matches => matches.length !== 1)) return stop('waiting-ci', 'missing-or-duplicate-check');
    if (relevant.some(matches => matches[0].headSha !== headSha)) return stop('waiting-ci', 'stale-ci-sha');
    if (relevant.some(matches => matches[0].status !== 'completed')) return stop('waiting-ci', 'ci-running');
    if (relevant.some(matches => matches[0].conclusion !== 'success')) return stop('blocked', 'ci-failed');
    if (!review || review.headSha !== headSha || review.status !== 'completed') return stop('waiting-review', 'review-incomplete');
    if (review.unresolvedFindings !== false) return stop('blocked', 'unresolved-findings');
    if (activeJobs !== 0) return stop('waiting-agent', 'agent-already-active');
    // Missing history is not equivalent to confirmed empty history.
    if (lastDispatchedSha !== null && (typeof lastDispatchedSha !== 'string' || !SHA.test(lastDispatchedSha))) {
        return stop('blocked', 'invalid-dispatch-history');
    }
    if (lastDispatchedSha === headSha) return stop('blocked', 'duplicate-dispatch');
    return { phase: 'verified', reason: 'ci-review-and-history-verified', mayDispatch: false };
}

export function evaluateLoop(input) {
    const verified = inspectCore(input);
    if (verified.phase !== 'verified') return verified;
    const provider = input.provider;
    if (!provider || provider.connected !== true || provider.includedUsageConfirmed !== true || provider.canLaunchUnattended !== true) {
        return stop('blocked', 'codex-dispatch-unverified');
    }
    return { phase: 'ready-for-dispatch', reason: 'gates-passed', mayDispatch: true };
}

/**
 * Manual handoff is preparation ONLY: it cannot dispatch to Codex.
 * It uses the same CI, review, branch, history and cost guards, but it does
 * not require an unattended-launch provider connection.
 */
export function evaluateManualReadiness(input) {
    const verified = inspectCore(input);
    if (verified.phase !== 'verified') return { ...verified, mayPrepareManual: false };
    return {
        phase: 'ready-for-manual-preparation',
        reason: 'human-approval-still-required',
        mayDispatch: false,
        mayPrepareManual: true,
    };
}
