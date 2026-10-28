/**
 * Deterministic, offline backlog prioritization. No external services or real issue data.
 * The user-approved static identifiers and dependencies are an explicit allowlist.
 */
import { proposeAssignment, validateTeamConfig } from './agent-team-core.mjs';

export const ROADMAP = Object.freeze([
    Object.freeze({ id: 'verify-pr3', capability: 'review', priority: 100, dependsOn: Object.freeze([]) }),
    Object.freeze({ id: 'copilot-sandbox-gate', capability: 'testing', priority: 90, dependsOn: Object.freeze(['verify-pr3']) }),
    Object.freeze({ id: 'team-controller-review', capability: 'security', priority: 80, dependsOn: Object.freeze(['verify-pr3']) }),
    Object.freeze({ id: 'agent-cost-and-permissions', capability: 'planning', priority: 70, dependsOn: Object.freeze(['copilot-sandbox-gate']) }),
    Object.freeze({ id: 'design-dispatch-gates', capability: 'documentation', priority: 60, dependsOn: Object.freeze(['agent-cost-and-permissions', 'team-controller-review']) }),
]);
const identifiers = new Set(ROADMAP.map(task => task.id));
/**
 * Completed tasks must come from verified records, not this planner's output.
 * An empty set is safest until GitHub evidence has been reviewed.
 */
export function planNextTasks(config, { completedTaskIds = [], baseBranch = 'miya-ai-dev' } = {}) {
    validateTeamConfig(config);
    if (baseBranch !== 'miya-ai-dev' || !Array.isArray(completedTaskIds)
        || new Set(completedTaskIds).size !== completedTaskIds.length
        || completedTaskIds.some(id => !identifiers.has(id))) {
        throw new Error('Invalid roadmap request or unverified task identifier');
    }
    const completed = new Set(completedTaskIds);
    const backlog = ROADMAP.filter(task => !completed.has(task.id)).map(task => {
        const missingDependencies = task.dependsOn.filter(id => !completed.has(id));
        const recommendation = proposeAssignment(config, {
            capability: task.capability,
            baseBranch,
        });
        return {
            taskId: task.id,
            capability: task.capability,
            priority: task.priority,
            status: missingDependencies.length ? 'blocked' : 'proposal-only',
            missingDependencies,
            proposedAgentId: recommendation.proposedAgentId,
            eligibleForAutomaticDispatch: false,
            dispatchPerformed: false,
            humanApprovalRequired: true,
        };
    });
    const ready = backlog.filter(task => task.status === 'proposal-only')
        .sort((a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId, 'en'));
    return {
        mode: 'proposal-only',
        baseBranch,
        completedTaskIds: [...completed],
        recommendedNextTask: ready[0] ?? null,
        backlog,
        tasksDispatched: 0,
        paidSpendUsd: 0,
        humanApprovalRequired: true,
    };
}
