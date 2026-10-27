import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLoop } from './continuous-loop-policy.mjs';

const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const valid = () => ({
    baseBranch: 'miya-ai-dev', headSha: sha, paidBudgetUsd: 0, productionAccess: false,
    autoMerge: false, activeJobs: 0, lastDispatchedSha: null,
    checks: [
        { name: 'MIYA AI Development Check', headSha: sha, status: 'completed', conclusion: 'success' },
        { name: '✅ Pull Request Checks', headSha: sha, status: 'completed', conclusion: 'success' },
    ],
    review: { headSha: sha, status: 'completed', unresolvedFindings: false },
    provider: { connected: true, includedUsageConfirmed: true, canLaunchUnattended: true },
});

test('only exact verified results permit a proposal to dispatch', () => {
    assert.deepEqual(evaluateLoop(valid()), { phase: 'ready-for-dispatch', reason: 'gates-passed', mayDispatch: true });
});

for (const [name, mutate, reason] of [
    ['wrong target', x => { x.baseBranch = 'release'; }, 'invalid-target'],
    ['no proof of free usage', x => { x.provider.includedUsageConfirmed = false; }, 'codex-dispatch-unverified'],
    ['unattended launch unverified', x => { x.provider.canLaunchUnattended = false; }, 'codex-dispatch-unverified'],
    ['previous launch for the SHA', x => { x.lastDispatchedSha = sha; }, 'duplicate-dispatch'],
    ['running agent', x => { x.activeJobs = 1; }, 'agent-already-active'],
    ['review has findings', x => { x.review.unresolvedFindings = true; }, 'unresolved-findings'],
    ['wrong review SHA', x => { x.review.headSha = 'b'.repeat(40); }, 'review-incomplete'],
    ['failed CI', x => { x.checks[0].conclusion = 'failure'; }, 'ci-failed'],
    ['old CI', x => { x.checks[1].headSha = 'b'.repeat(40); }, 'stale-ci-sha'],
    ['missing CI', x => { x.checks.pop(); }, 'missing-or-duplicate-check'],
    ['extra charge', x => { x.paidBudgetUsd = 1; }, 'unsafe-permissions'],
    ['production access', x => { x.productionAccess = true; }, 'unsafe-permissions'],
    ['automatic merge', x => { x.autoMerge = true; }, 'unsafe-permissions'],
]) {
    test('blocks ' + name, () => {
        const data = valid();
        mutate(data);
        assert.equal(evaluateLoop(data).reason, reason);
        assert.equal(evaluateLoop(data).mayDispatch, false);
    });
}
