/**
 * Human-in-the-loop gate. This module never merges or invokes Codex.
 * An approval must match the exact reviewed and tested source SHA.
 */
const SHA = /^[a-f0-9]{40}$/;
const reject = reason => ({ approvedForNextTask: false, reason });
export function evaluateHumanHandoff({ sourceSha, checksPassed, reviewPassed, approval, targetBranch, paidBudgetUsd, allowProduction, autoMerge } = {}) {
    if (!SHA.test(sourceSha ?? '') || targetBranch !== 'miya-ai-dev') return reject('invalid-target');
    if (paidBudgetUsd !== 0 || allowProduction !== false || autoMerge !== false) return reject('unsafe-permissions');
    if (checksPassed !== true || reviewPassed !== true) return reject('verification-incomplete');
    if (!approval || approval.decision !== 'approve-next-task'
        || approval.sourceSha !== sourceSha
        || approval.actorType !== 'human'
        || typeof approval.actor !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(approval.actor)
        || approval.rejected === true) return reject('human-approval-required');
    return { approvedForNextTask: true, reason: 'human-approved', taskLaunchAuthorized: false };
}
