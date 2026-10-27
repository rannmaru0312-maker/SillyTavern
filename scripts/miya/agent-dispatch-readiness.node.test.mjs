import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDispatchStop } from './agent-dispatch-readiness.mjs';

test('429 does not claim a confirmed billing exhaustion', () => {
    const r = classifyDispatchStop({ provider: 'codex', status: 429, code: '' });
    assert.equal(r.category, 'rate-limited');
    assert.equal(r.causeVerified, false);
    assert.equal(r.extraChargeApproved, false);
    assert.equal(r.automaticDispatchStopped, true);
});
test('explicit quota code is confirmed', () => {
    const r = classifyDispatchStop({ provider: 'codex', status: 429, code: 'usage_limit_reached' });
    assert.equal(r.category, 'usage-limit');
    assert.equal(r.causeVerified, true);
});
test('billing limit cannot approve extra charges', () => {
    const r = classifyDispatchStop({ provider: 'copilot', status: 402, code: 'billing_hard_limit_reached' });
    assert.equal(r.category, 'billing-limit');
    assert.equal(r.extraChargeApproved, false);
    assert.equal(r.requiresUserAction, true);
});
test('GitHub Issues disabled yields explicit resource disabled', () => {
    const r = classifyDispatchStop({ provider: 'github', status: 410, code: '' });
    assert.equal(r.category, 'resource-disabled');
});
test('403 cannot auto escalate', () => {
    const r = classifyDispatchStop({ provider: 'github', status: 403, code: '' });
    assert.equal(r.category, 'permission-denied');
});
test('temporary network errors ask for pause', () => {
    const r = classifyDispatchStop({ provider: 'work', status: 503, code: '' });
    assert.equal(r.category, 'temporary-network-failure');
    assert.equal(r.requiresUserAction, false);
});
test('unknown failure is not called quota', () => {
    const r = classifyDispatchStop({ provider: 'github-actions', status: 500, code: '' });
    assert.equal(r.category, 'unverified');
    assert.equal(r.causeVerified, false);
});
test('rejects response bodies and unknown fields as provider status', () => {
    assert.throws(() => classifyDispatchStop({ provider: 'unknown', status: 429, code: '' }));
    assert.throws(() => classifyDispatchStop({ provider: 'codex', status: 429, code: 'api key: secret' }));
    assert.throws(() => classifyDispatchStop(null));
});
