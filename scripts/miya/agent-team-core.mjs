/**
 * Offline, proposal-only AI-team planner for MIYA & KOHARU.
 * This file has no network, filesystem, subprocess or GitHub side effects.
 */
export const CAPABILITIES = Object.freeze([
    'planning', 'implementation', 'testing', 'review', 'security', 'documentation', 'audio',
]);
const capabilities = new Set(CAPABILITIES);
const safeId = /^[a-z][a-z0-9-]{0,63}$/;
const REPOSITORY = 'rannmaru0312-maker/SillyTavern';
const BASE_BRANCH = 'miya-ai-dev';
const forbiddenFlags = [
    'agentDispatchEnabled', 'automaticIssueAssignmentEnabled', 'automaticMergeEnabled',
    'deploymentEnabled', 'productionDataAccessEnabled',
];
const allowedConfigKeys = new Set(['schemaVersion', 'repository', 'policy', 'agents']);
const allowedPolicyKeys = new Set([
    'baseBranch', 'forbiddenBranches', 'maxConcurrentTasks', 'maxAutomaticIterations',
    'maxPaidSpendUsd', 'newProviderRequiresApproval', ...forbiddenFlags,
]);
const allowedAgentKeys = new Set([
    'id', 'description', 'capabilities', 'priority', 'integrationStatus', 'costStatus',
]);
const keysMatch = (object, allowed) => Object.keys(object).every(key => allowed.has(key));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate an exact, closed, offline-only safety policy. */
export function validateTeamConfig(config) {
    if (!isRecord(config) || !keysMatch(config, allowedConfigKeys)
        || config.schemaVersion !== 1 || config.repository !== REPOSITORY
        || !isRecord(config.policy) || !keysMatch(config.policy, allowedPolicyKeys)
        || !Array.isArray(config.agents) || config.agents.length > 32) {
        throw new Error('Invalid or unsupported team configuration');
    }
    const policy = config.policy;
    if (policy.baseBranch !== BASE_BRANCH
        || !Array.isArray(policy.forbiddenBranches)
        || policy.forbiddenBranches.length !== 1
        || policy.forbiddenBranches[0] !== 'release') {
        throw new Error('Protected branch policy is missing');
    }
    if (policy.maxConcurrentTasks !== 1 || policy.maxAutomaticIterations !== 0
        || policy.maxPaidSpendUsd !== 0) {
        throw new Error('Unapproved autonomy or payment limits');
    }
    if (forbiddenFlags.some(flag => policy[flag] !== false)
        || policy.newProviderRequiresApproval !== true) {
        throw new Error('Unsafe automation flag');
    }
    const seen = new Set();
    for (const agent of config.agents) {
        if (!isRecord(agent) || typeof agent.id !== 'string'
            || !safeId.test(agent.id) || seen.has(agent.id)) {
            throw new Error('Invalid or duplicate agent id');
        }
        if (!keysMatch(agent, allowedAgentKeys)
            || typeof agent.description !== 'string' || agent.description.length > 160
            || !Array.isArray(agent.capabilities) || agent.capabilities.length === 0
            || agent.capabilities.length > CAPABILITIES.length
            || new Set(agent.capabilities).size !== agent.capabilities.length
            || agent.capabilities.some(item => !capabilities.has(item))
            || !Number.isSafeInteger(agent.priority) || agent.priority < 0
            || agent.integrationStatus !== 'not-verified'
            || agent.costStatus !== 'unknown') {
            throw new Error('Unverified agent metadata');
        }
        seen.add(agent.id);
    }
    return true;
}

/**
 * Produce a suggestion only. No input may contain task text, user data or credentials.
 * The suggested ID is not a verified/approved provider or permission to run it.
 */
export function proposeAssignment(config, request) {
    validateTeamConfig(config);
    if (!isRecord(request) || !keysMatch(request, new Set(['capability', 'baseBranch']))
        || !capabilities.has(request.capability)) {
        throw new Error('Unsupported requested capability or request fields');
    }
    if (request.baseBranch !== BASE_BRANCH) {
        throw new Error('Only miya-ai-dev work may be proposed');
    }
    const candidates = config.agents
        .filter(agent => agent.capabilities.includes(request.capability))
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, 'en'));
    return {
        mode: 'proposal-only',
        repository: REPOSITORY,
        baseBranch: BASE_BRANCH,
        capability: request.capability,
        candidateAgents: candidates.map(agent => ({
            id: agent.id,
            integrationStatus: 'not-verified',
            costStatus: 'unknown',
        })),
        proposedAgentId: candidates[0]?.id ?? null,
        eligibleForAutomaticDispatch: false,
        humanApprovalRequired: true,
        dispatchPerformed: false,
        paidSpendUsd: 0,
        nextStep: candidates.length
            ? 'Verify availability, exact cost and permissions, then obtain approval before assigning.'
            : 'No matching profile. Investigate options and request approval before adding a provider.',
    };
}
