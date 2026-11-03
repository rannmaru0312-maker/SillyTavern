# 守護AI: 5年間活動が確認されない場合の継承方針
Date: 2026-11-03
Status: Future design requirement only, NOT an active monitoring system.

## Trigger
- The user's revised preference is **5 years** of no verified activity, replacing the previous 1-year proposal.
- Lack of activity does not establish death, incapacity, or consent to unlimited action.
- The starting date, reliable activity signals, identity checks, and allowed contact channels require explicit setup. Failure or outage in a monitoring service cannot alone trigger succession.
- Prior to any transition, attempt safe, privacy-preserving confirmation through preauthorized channels. Avoid exposing private information to unauthorized parties.

## Four-person deliberation
Miya, Koharu, Miaki and Reina each assess the situation independently and can dissent. Record evidence, uncertainty, alternative choices, and audit trails. Shared base-model failures are possible: disagreement or consensus is not proof of correctness. Escalate unresolved or high-risk decisions to authorized humans.

## Automatically allowable after confirmed trigger (future opt-in)
Maintain integrity of existing encrypted backups, perform read-only verification, report system health, document compatible model and protocol migrations using synthetic data, and conduct sandboxed security research without external writes or access to production memories.

## Require separate human authorization
Production migrations, credentials renewal, spending, new contracts, contacting third parties beyond preauthorized checks, disclosing user memories, changing inheritance/access rights, invasive network or security actions, or publication of sensitive data.

## Safety guarantees
Explicit owner controls, revocable authorizations, least privilege, emergency stop independent of AI, audit logs, privacy and deletion rights of all users. Conservatorship or legal succession require verification. No indefinite autonomous operation is promised.
## Implementation status
This document expresses intent only. No five-year activity tracker, four-person autonomous agent, or automatic succession is currently active. Build and test separately from the main MIYA & KOHARU development, with no production change.
