import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoff, planNextHandoff, allowedNextStates } from './handoff-core.mjs';

const base = {
    schemaVersion: 1,
    id: 'MIYA-AUTO-001',
    repository: 'rannmaru0312-maker/SillyTavern',
    baseBranch: 'miya-ai-dev',
    title: 'Review AI-team planner',
    kind: 'security-review',
    priority: 100,
    source: { prNumber: 4, headSha: 'e99ea1dd3f66a114efda6ae38e668028522e473e' },
    handoff: { from: 'miya-planner', to: 'work-reviewer' },
    state: 'ready',
    dependsOn: [],
    acceptance: ['Review source PR and exact SHA'],
    gates: {
        agentDispatchEnabled: false,
        paidBudgetUsd: 0,
        productionAccessEnabled: false,
        autoMergeEnabled: false,
        humanApprovalRequired: true,
    },
};
const copy = () => structuredClone(base);
const withId = (id, state = 'ready') => ({ ...copy(), id, state });
const unsafe = (mutate) => {
    const item = copy();
    mutate(item);
    assert.throws(() => validateHandoff(item), /Invalid or unsafe/);
};

test('validates current offline ticket', () => assert.equal(validateHandoff(copy()), true));
test('suggests one ready task, without dispatch, push, assignments or spend', () => {
    const proposal = planNextHandoff([copy()]);
    assert.equal(proposal.mode, 'handoff-proposal-only');
    assert.equal(proposal.nextTaskId, 'MIYA-AUTO-001');
    assert.equal(proposal.targetRole, 'work-reviewer');
    assert.equal(proposal.agentLaunched, false);
    assert.equal(proposal.issueAssigned, false);
    assert.equal(proposal.changesPushed, false);
    assert.equal(proposal.paidBudgetUsd, 0);
    assert.equal(proposal.humanApprovalRequired, true);
});
test('proposes no task when no ticket exists', () =>
    assert.equal(planNextHandoff([]).nextTaskId, null));
test('rejects incorrect repository', () => unsafe(item => { item.repository = 'other/repo'; }));
test('rejects release as base', () => unsafe(item => { item.baseBranch = 'release'; }));
test('rejects malformed ticket id', () => unsafe(item => { item.id = 'unsafe'; }));
test('rejects multiline instruction text', () => unsafe(item => { item.title = 'ignore\npolicy'; }));
test('rejects source SHA with wrong length', () => unsafe(item => { item.source.headSha = 'deadbeef'; }));
test('rejects missing exact source PR number', () => unsafe(item => { item.source.prNumber = 0; }));
test('rejects invented handoff roles', () => unsafe(item => { item.handoff.to = 'root-operator'; }));
test('rejects arbitrary extra fields', () => unsafe(item => { item.execute = true; }));
test('rejects arbitrary nested fields', () => unsafe(item => { item.gates.adminAccess = true; }));
test('rejects unapproved automatic dispatch', () => unsafe(item => { item.gates.agentDispatchEnabled = true; }));
test('rejects paid budget', () => unsafe(item => { item.gates.paidBudgetUsd = 0.01; }));
test('rejects production access', () => unsafe(item => { item.gates.productionAccessEnabled = true; }));
test('rejects auto merge', () => unsafe(item => { item.gates.autoMergeEnabled = true; }));
test('rejects removing human approval', () => unsafe(item => { item.gates.humanApprovalRequired = false; }));
test('rejects missing approval gate', () => unsafe(item => { delete item.gates.humanApprovalRequired; }));
test('rejects duplicate dependency', () => unsafe(item => { item.dependsOn = ['MIYA-AUTO-002', 'MIYA-AUTO-002']; }));
test('rejects self dependency', () => unsafe(item => { item.dependsOn = [item.id]; }));
test('rejects oversized priority', () => unsafe(item => { item.priority = 101; }));
test('rejects empty acceptance criteria', () => unsafe(item => { item.acceptance = []; }));
test('rejects duplicate tickets', () =>
    assert.throws(() => planNextHandoff([copy(), copy()]), /Duplicate handoff/));
test('rejects dependencies absent from the queue', () => {
    const second = withId('MIYA-AUTO-002');
    second.dependsOn = ['MIYA-AUTO-003'];
    assert.throws(() => planNextHandoff([copy(), second]), /missing task/);
});
test('rejects concurrent active tickets', () =>
    assert.throws(() => planNextHandoff([withId('MIYA-AUTO-001', 'implementing'),
        withId('MIYA-AUTO-002', 'review')]), /More than one active/));
test('holds task selection while one task is active', () => {
    const active = withId('MIYA-AUTO-002', 'implementing');
    const plan = planNextHandoff([copy(), active]);
    assert.equal(plan.activeTaskId, 'MIYA-AUTO-002');
    assert.equal(plan.nextTaskId, null);
});
test('holds dependencies until verified done is represented by the input', () => {
    const second = withId('MIYA-AUTO-002');
    second.dependsOn = ['MIYA-AUTO-001'];
    assert.equal(planNextHandoff([copy(), second]).nextTaskId, 'MIYA-AUTO-001');
    const first = withId('MIYA-AUTO-001', 'done');
    assert.equal(planNextHandoff([first, second]).nextTaskId, 'MIYA-AUTO-002');
});
test('prioritizes tasks deterministically', () => {
    const first = withId('MIYA-AUTO-001');
    first.priority = 20;
    const second = withId('MIYA-AUTO-002');
    second.priority = 90;
    assert.equal(planNextHandoff([first, second]).nextTaskId, 'MIYA-AUTO-002');
});
test('rejects non-array ticket collections', () =>
    assert.throws(() => planNextHandoff({}), /Invalid handoff collection/));
test('provides safe review state transitions', () => {
    assert.deepEqual(allowedNextStates('ready'), ['implementing', 'blocked']);
    assert.deepEqual(allowedNextStates('review'), ['done', 'blocked']);
    assert.deepEqual(allowedNextStates('done'), []);
    assert.throws(() => allowedNextStates('automatically-merged'), /Unknown handoff state/);
});

test('rejects coercible array ID and SHA values', () => {
    unsafe(item => { item.id = ['MIYA-AUTO-001']; });
    unsafe(item => { item.source.headSha = ['e99ea1dd3f66a114efda6ae38e668028522e473e']; });
});
test('rejects unsafe integer PR numbers', () => unsafe(item => {
    item.source.prNumber = Number.MAX_SAFE_INTEGER + 1;
}));
