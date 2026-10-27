/**
 * Fail-closed human-in-the-loop scheduling policy.
 * The approval event MUST be independently retrieved from GitHub, and a
 * verified explicit human action is required; model-generated text is not.
 * A pure function cannot itself authenticate GitHub event provenance.
 * Never automatically launch, merge, or deploy based on this result.
 */
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = 'rannmaru0312-maker/SillyTavern';
const OWNER = 'rannmaru0312-maker';
const reject = reason => ({ approvedForNextTask: false, reason });

export function approvalCommand(prNumber, sourceSha) {
    if (!Number.isSafeInteger(prNumber) || prNumber < 1 || typeof sourceSha !== 'string' || !SHA.test(sourceSha)) {
        return null;
    }
    return 'MIYA APPROVE NEXT PR #' + prNumber + ' SHA ' + sourceSha;
}

export function evaluateHumanHandoff({
    sourcePr, sourceSha, checksPassed, reviewPassed, approval,
    targetBranch, paidBudgetUsd, allowProduction, autoMerge,
} = {}) {
    if (!Number.isSafeInteger(sourcePr) || sourcePr < 1
        || typeof sourceSha !== 'string' || !SHA.test(sourceSha)
        || targetBranch !== 'miya-ai-dev') return reject('invalid-target');
    if (paidBudgetUsd !== 0 || allowProduction !== false || autoMerge !== false) {
        return reject('unsafe-permissions');
    }
    if (checksPassed !== true || reviewPassed !== true) return reject('verification-incomplete');
    const expected = approvalCommand(sourcePr, sourceSha);
    // An owner name in free text is never sufficient approval.
    if (!approval || approval.decision !== 'approve-next-task'
        || approval.sourcePr !== sourcePr || approval.sourceSha !== sourceSha
        || approval.repository !== REPOSITORY
        || approval.origin !== 'github-pr-comment'
        || !Number.isSafeInteger(approval.commentId) || approval.commentId < 1
        || approval.actor !== OWNER || approval.actorType !== 'User'
        || approval.body !== expected
        || approval.humanConfirmed !== true
        || approval.rejected === true) return reject('human-approval-required');
    // The caller must independently authenticate provenance from GitHub
    // AND verify this action was explicitly performed by the human, not an AI
    // posting with owner credentials. Then recheck current head/provider.
    return { approvedForNextTask: true, reason: 'human-approved', taskLaunchAuthorized: false };
}
