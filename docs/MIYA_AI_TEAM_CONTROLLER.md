# MIYA AI team controller: Phase 1 (proposal only)

This module is deliberately **offline and non-executing**. Its output is a suggestion, not evidence that an AI agent is installed, authorized, affordable or running. It never contacts GitHub or a model API, edits production data, merges PRs, assigns Issues, or spends money.

## Try locally

```bash
node scripts/miya/agent-team.mjs --capability implementation
node scripts/miya/agent-roadmap-cli.mjs
npm --prefix tests run test:unit -- --runInBand miya-agent-team.test.js
```

The CLI reads only its checked-in JSON policy. Agent entries are **unverified candidate profiles**. The cost is unknown, so none is eligible for automatic dispatch. Completed roadmap IDs must be supplied only after verifying GitHub evidence; the standalone CLI intentionally marks none completed.

## Safety invariants

- Repository: `rannmaru0312-maker/SillyTavern`; development PR base: `miya-ai-dev`.
- Never modify `release`, the live server, production memory or real user records.
- No paid spend, external provider enrollment, automatic assignment/merge, deployment or background agent execution.
- A real workflow needs separate GitHub authorization, isolated development branches, code review, tests, rate limits, and human approval for sensitive decisions.
- PR #2 and PR #3 were separate unmerged drafts when this phase was authored. Do not silently pull either diff into this PR.
- This module is not a security boundary: production permission enforcement must be implemented and tested in the actual execution layer.

## CI and handoff

For this branch, compare the PR against `miya-ai-dev`, run the repository Jest and ESLint checks, review the exact head SHA and confirm no production paths were touched. Do not merge or deploy this draft PR without explicit user approval.
