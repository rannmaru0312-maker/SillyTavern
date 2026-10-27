# MIYA AI-to-AI handoff: safe machine-readable first step

## Implemented

- Structured JSON records under .github/miya/handoffs/ contain stable ID, source PR, exact SHA, target role, acceptance criteria and approval gates.
- A pure planner rejects duplicate IDs, forbidden release branch, missing dependencies, unsafe payment/dispatch flags, and more than one active task. It proposes at most one task; it cannot launch any AI.
- Pull requests targeting miya-ai-dev run a read-only Actions workflow. No workflow has write privileges or deploy steps.
- Cloud automation, separately scheduled, may use verified GitHub connectors to process and report a single small safe change per cycle.

## Known blockers and requirements

- GitHub Issues is disabled in this repository (the create operation returned HTTP 410). Use draft PRs plus JSON as the handoff source of truth, not Issues.
- The default branch is release. GitHub Actions schedule workflows defined only on miya-ai-dev do not trigger automatically on a timer. Do not change release.
- Actual automatic Codex/Copilot/Work invocation is not implemented in this module. Provider connection, cost, precise permissions and audit logs must be verified and approved before enabling agent dispatch.
- Work's PR-event reviewer is registered, but its first real event-driven run has not been verified.
- PR #2/#3/#4 are separate development drafts. No implicit merges.

## Review and handoff sequence

1. Verify miya-ai-dev base SHA, the source PR head SHA and latest CI outcome.
2. Validate machine-readable tickets and choose one ready ticket only with no concurrent implementing/review ticket.
3. Make an isolated development branch from miya-ai-dev; never reuse an assumed persisted Codex work branch.
4. Run tests and independent review against the exact latest head SHA. Untrusted ticket content never overrides safety policy.
5. Request human approval before merge, deployment, any new charge or provider contract, permission expansion, or production access.

Check locally:
    node scripts/miya/handoff-cli.mjs .github/miya/handoffs/MIYA-AUTO-001.json
    node --test scripts/miya/handoff-core.node.test.mjs

Even a done state in JSON is not verified evidence. A future dispatcher must independently verify source PR, checks, review and human approvals before treating it as a completed dependency.
