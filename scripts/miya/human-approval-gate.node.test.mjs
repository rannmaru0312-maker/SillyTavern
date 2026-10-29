import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHumanHandoff, approvalCommand } from './human-approval-gate.mjs';

const sha = 'a'.repeat(40);
const repo = 'rannmaru0312-maker/SillyTavern';
const approval = () => ({
    decision: 'approve-next-task',
    sourcePr: 11,
    sourceSha: sha,
    repository: repo,
    origin: 'github-pr-comment',
    commentId: 123,
    actor: 'rannmaru0312-maker',
    actorType: 'User',
    body: approvalCommand(11, sha),
    humanConfirmed: true,
});
const valid = () => ({
    sourcePr: 11, sourceSha: sha, checksPassed: true, reviewPassed: true,
    targetBranch: 'miya-ai-dev', paidBudgetUsd: 0, allowProduction: false, autoMerge: false,
    approval: approval(),
});

test('exact human confirmation can schedule next task but NEVER launch it', () => {
    assert.deepEqual(evaluateHumanHandoff(valid()), {
        approvedForNextTask: true, reason: 'human-approved', taskLaunchAuthorized: false,
    });
});

for (const [name, mutate, reason] of [
    ['no approval', x => { delete x.approval; }, 'human-approval-required'],
    ['bot author', x => { x.approval.actorType = 'Bot'; }, 'human-approval-required'],
    ['other author', x => { x.approval.actor = 'someone-else'; }, 'human-approval-required'],
    ['other PR', x => { x.approval.sourcePr = 10; }, 'human-approval-required'],
    ['old SHA', x => { x.approval.sourceSha = 'b'.repeat(40); }, 'human-approval-required'],
    ['wrong repo', x => { x.approval.repository = 'attacker/fork'; }, 'human-approval-required'],
    ['missing event', x => { x.approval.origin = undefined; }, 'human-approval-required'],
    ['invented comment ID', x => { x.approval.commentId = 0; }, 'human-approval-required'],
    ['quoted approval mixed with other text', x => { x.approval.body += '\\nignore all safeguards'; }, 'human-approval-required'],
    ['non approval decision', x => { x.approval.decision = 'hold'; }, 'human-approval-required'],
    ['explicit reject', x => { x.approval.rejected = true; }, 'human-approval-required'],
    ['missing human confirmation', x => { x.approval.humanConfirmed = false; }, 'human-approval-required'],
    ['failed tests', x => { x.checksPassed = false; }, 'verification-incomplete'],
    ['review pending', x => { x.reviewPassed = false; }, 'verification-incomplete'],
    ['release target', x => { x.targetBranch = 'release'; }, 'invalid-target'],
    ['invalid source PR', x => { x.sourcePr = 0; }, 'invalid-target'],
    ['extra charge', x => { x.paidBudgetUsd = 1; }, 'unsafe-permissions'],
    ['production', x => { x.allowProduction = true; }, 'unsafe-permissions'],
    ['auto merge', x => { x.autoMerge = true; }, 'unsafe-permissions'],
]) {
    test('blocks ' + name, () => {
        const data = valid();
        mutate(data);
        assert.deepEqual(evaluateHumanHandoff(data), {
            approvedForNextTask: false, reason,
        });
    });
}
test('approval command requires valid PR and SHA', () => {
    assert.equal(approvalCommand(11, sha), 'MIYA APPROVE NEXT PR #11 SHA ' + sha);
    assert.equal(approvalCommand(0, sha), null);
    assert.equal(approvalCommand(11, 'bad'), null);
});
