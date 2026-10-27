import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, proposeAssignment, validateTeamConfig } from '../scripts/miya/agent-team-core.mjs';
import { planNextTasks } from '../scripts/miya/agent-roadmap.mjs';

const filename = fileURLToPath(new URL('../scripts/miya/agent-team.config.json', import.meta.url));
const original = JSON.parse(readFileSync(filename, 'utf8'));
const copy = () => structuredClone(original);
const plan = (config, capability = 'implementation', baseBranch = 'miya-ai-dev') =>
    proposeAssignment(config, { capability, baseBranch });

describe('MIYA AI team coordinator (proposal-only)', () => {
    test('accepts the initial safe registry', () => {
        expect(validateTeamConfig(copy())).toBe(true);
    });

    test.each(CAPABILITIES)('produces a safe proposal for %s', capability => {
        const result = plan(copy(), capability);
        expect(result.mode).toBe('proposal-only');
        expect(result.humanApprovalRequired).toBe(true);
        expect(result.dispatchPerformed).toBe(false);
        expect(result.paidSpendUsd).toBe(0);
        expect(result.baseBranch).toBe('miya-ai-dev');
    });

    test('selects Copilot profile for implementation without dispatch', () => {
        expect(plan(copy()).proposedAgentId).toBe('github-copilot');
    });

    test('selects Work profile for review', () => {
        expect(plan(copy(), 'review').proposedAgentId).toBe('chatgpt-work');
    });

    test('rejects a release branch request', () => {
        expect(() => plan(copy(), 'testing', 'release')).toThrow('Only miya-ai-dev');
    });

    test('rejects an unsupported capability', () => {
        expect(() => plan(copy(), 'administration')).toThrow('Unsupported requested capability');
    });

    test.each([
        'agentDispatchEnabled', 'automaticIssueAssignmentEnabled',
        'automaticMergeEnabled', 'deploymentEnabled', 'productionDataAccessEnabled',
    ])('refuses a dangerous %s configuration', flag => {
        const config = copy();
        config.policy[flag] = true;
        expect(() => plan(config)).toThrow('Unsafe automation flag');
    });

    test('rejects positive paid spend', () => {
        const config = copy();
        config.policy.maxPaidSpendUsd = 1;
        expect(() => plan(config)).toThrow('Unapproved autonomy or payment limits');
    });

    test('rejects automatic task iterations', () => {
        const config = copy();
        config.policy.maxAutomaticIterations = 1;
        expect(() => plan(config)).toThrow('Unapproved autonomy or payment limits');
    });

    test('rejects concurrent autonomous work', () => {
        const config = copy();
        config.policy.maxConcurrentTasks = 2;
        expect(() => plan(config)).toThrow('Unapproved autonomy or payment limits');
    });

    test('rejects removing release from prohibited branches', () => {
        const config = copy();
        config.policy.forbiddenBranches = [];
        expect(() => plan(config)).toThrow('Protected branch policy');
    });

    test('rejects duplicate agent ids', () => {
        const config = copy();
        config.agents.push(structuredClone(config.agents[0]));
        expect(() => plan(config)).toThrow('Invalid or duplicate agent id');
    });

    test('rejects pretending an unverified agent is connected', () => {
        const config = copy();
        config.agents[0].integrationStatus = 'connected';
        expect(() => plan(config)).toThrow('Unverified agent metadata');
    });

    test('returns no candidate when the profile list is empty', () => {
        const config = copy();
        config.agents = [];
        expect(plan(config).proposedAgentId).toBeNull();
        expect(plan(config).humanApprovalRequired).toBe(true);
    });

    test('suggests PR #3 review first with all other tasks blocked', () => {
        const roadmap = planNextTasks(copy());
        expect(roadmap.recommendedNextTask.taskId).toBe('verify-pr3');
        expect(roadmap.tasksDispatched).toBe(0);
        expect(roadmap.paidSpendUsd).toBe(0);
        expect(roadmap.backlog.filter(t => t.status === 'blocked').length).toBe(4);
    });

    test('unblocks dependent tasks only on explicitly supplied completed IDs', () => {
        const roadmap = planNextTasks(copy(), { completedTaskIds: ['verify-pr3'] });
        expect(roadmap.recommendedNextTask.taskId).toBe('copilot-sandbox-gate');
        expect(roadmap.tasksDispatched).toBe(0);
    });

    test('refuses unknown completion IDs and release roadmap', () => {
        expect(() => planNextTasks(copy(), { completedTaskIds: ['fake-complete'] })).toThrow();
        expect(() => planNextTasks(copy(), { baseBranch: 'release' })).toThrow();
    });
});
