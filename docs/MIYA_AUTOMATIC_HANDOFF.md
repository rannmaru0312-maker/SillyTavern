# MIYA AI-to-AI handoff: safe machine-readable first step

## Implemented

- Structured JSON records under .github/miya/handoffs/ contain stable ID, source PR, exact SHA, target role, acceptance criteria and approval gates.
- A pure planner rejects duplicate IDs, forbidden release branch, missing dependencies, unsafe payment/dispatch flags, and more than one active task. It proposes at most one task; it cannot launch any AI.
- Pull requests targeting miya-ai-dev run a read-only Actions workflow. This newly added handoff workflow explicitly has only contents: read. Existing workflows must be assessed separately; their permissions may differ.
- Cloud automation, separately scheduled, may use verified GitHub connectors to process and report a single small safe change per cycle.

## Known blockers and requirements

- GitHub Issues is disabled in this repository (the create operation returned HTTP 410). Use draft PRs plus JSON as the handoff source of truth, not Issues.
- The default branch is release. GitHub Actions schedule workflows defined only on miya-ai-dev do not trigger automatically on a timer. Do not change release.
- Actual automatic Codex/Copilot invocation is not implemented in this module. Provider connection, cost, precise permissions and audit logs must be verified and approved before enabling agent dispatch. Existing Work-based PR review automations have run; their execution is independent from this pure module.
- GitHub Copilot agent automations currently require a **private or internal** repository and an eligible paid Copilot plan. This repository is **public**, so Copilot automations cannot be enabled here without an independently approved repository/plan change. GitHub Issues is also disabled, blocking the usual issue-assignment workflow.
- Codex Cloud environments exist, but this ChatGPT GitHub connector does not expose a direct Codex Cloud task-launch API. Creating a ticket is not launching Codex. For unattended Codex dispatch, an official supported runtime/scheduler, verified plan permissions and explicit approval for extra costs are required.
- A safe stoppage classifier records verified provider quota, 429 rate limits, 403 permissions, GitHub Issues 410 and network blocks without silently retrying or authorizing charges. A scheduled task separately reports actual blockers and limits to the owner.
- Work's PR-event reviewer is registered and a completed review of PR #5 has been observed. It found two safety and ESLint coverage issues; the follow-up amendments added explicit type checks and lint coverage.
- PR #2/#3/#4 are separate development drafts. No implicit merges.

## Review and handoff sequence

1. Verify miya-ai-dev base SHA, the source PR head SHA and latest CI outcome.
2. Validate machine-readable tickets and choose one ready ticket only with no concurrent implementing/review ticket.
3. Make an isolated development branch from miya-ai-dev; never reuse an assumed persisted Codex work branch.
4. Run tests and independent review against the exact latest head SHA. Untrusted ticket content never overrides safety policy.
5. Request human approval before merge, deployment, any new charge or provider contract, permission expansion, or production access.

Check locally:
    node scripts/miya/handoff-cli.mjs .github/miya/handoffs/MIYA-AUTO-001.json
    node --test scripts/miya/handoff-core.node.test.mjs scripts/miya/agent-dispatch-readiness.node.test.mjs

Even a done state in JSON is not verified evidence. A future dispatcher must independently verify source PR, checks, review and human approvals before treating it as a completed dependency.
