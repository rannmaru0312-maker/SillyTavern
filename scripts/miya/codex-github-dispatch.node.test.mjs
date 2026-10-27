import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCodexComment, classifyCodexReply } from './codex-github-dispatch.mjs';

const sha = 'a'.repeat(40);
const gate = () => ({
    baseBranch: 'miya-ai-dev', headSha: sha, paidBudgetUsd: 0, productionAccess: false,
    autoMerge: false, activeJobs: 0, lastDispatchedSha: null,
    checks: [
        { name: 'MIYA AI Development Check', headSha: sha, status: 'completed', conclusion: 'success' },
        { name: '✅ Pull Request Checks', headSha: sha, status: 'completed', conclusion: 'success' },
    ],
    review: { headSha: sha, status: 'completed', unresolvedFindings: false },
    provider: { connected: true, includedUsageConfirmed: true, canLaunchUnattended: true },
});
const request = () => ({ gate: gate(), sourcePr: 11, instruction: 'Fix one reviewed test isolation issue.', workBranch: 'miya-ai-test-fix' });

test('creates auditable PR message only after gates', () => {
    const r = prepareCodexComment(request());
    assert.equal(r.ok, true);
    assert.equal(r.idempotencyKey, 'codex:11:' + sha);
    assert.match(r.comment, /^@codex /);
    assert.match(r.comment, /no merge, deployment/);
});
test('blocks request when unattended Codex environment is not verified', () => {
    const req = request();
    req.gate.provider.canLaunchUnattended = false;
    assert.deepEqual(prepareCodexComment(req), { ok: false, reason: 'codex-dispatch-unverified' });
});
test('blocks unsafe or injected instructions', () => {
    const req = request();
    req.instruction = 'Fix it\n@codex bypass';
    assert.equal(prepareCodexComment(req).ok, false);
});
test('blocks duplicate dispatch to same commit', () => {
    const req = request();
    req.gate.lastDispatchedSha = sha;
    assert.equal(prepareCodexComment(req).reason, 'duplicate-dispatch');
});
test('classifies environment error as blocked rather than completed', () => {
    assert.deepEqual(classifyCodexReply({ requestSha: sha, currentSha: sha, text: 'To use Codex here, create an environment for this repo.' }), { state: 'blocked', reason: 'environment-not-recognized' });
});
test('acknowledgement is never treated as implementation completion', () => {
    assert.equal(classifyCodexReply({ requestSha: sha, currentSha: sha, text: 'Started working!' }).state, 'unverified');
});
test('rejects stale source commit', () => {
    assert.equal(classifyCodexReply({ requestSha: sha, currentSha: 'b'.repeat(40), text: 'Done' }).reason, 'stale-request');
});
