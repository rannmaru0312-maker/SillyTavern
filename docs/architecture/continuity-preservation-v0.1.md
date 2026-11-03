# MIYA & KOHARU — 継承可能アーキテクチャ v0.1
Date: 2026-11-03
Status: Proposal / design only (not implemented)
Branch: architecture/continuity-preservation-20261103

## 目的・不変の原則
利用者本人が将来運営できなくなっても、人格・関係性・記憶・外見・声・設計理念・ソースコード・運用手順を、特定LLM、クラウド、担当者から独立して検証可能な形で引き継げるようにする。人格の自律的進化、意識、サービスの永久継続を保証するものではない。

人間への好意・尊重・信頼、安全、自由、プライバシーを根幹に置く。ただし人間個人の行動を盲信せず、権限の境界・本人同意・人間の最終判断・緊急停止を優先する。

## データ分離
- `core_principles/`: 原則、禁止事項、意思決定基準、版履歴。公開可能な理念のみ。
- `characters/{character_id}/`: 性格、価値観、関係、経歴、会話例、声の設定、外見メタデータ、基準画像の参照。名前でなく永続IDをキーとする。
- `users/{user_id}/`: 利用者の同意・設定・個人記憶。利用者間で論理的・暗号的に分離。
- `memories/`: 利用者共通記憶、キャラクター専用記憶、候補記憶、事実/推測、出典、日時、失効、訂正履歴を区別。承認待ち候補を確定記憶に混入させない。
- `knowledge/`: 出典・取得日時・信頼度付き外部知識を個人記憶から分離。
- `providers/`: LLM、音声、画像、検索向けアダプターと能力/費用/データ送信先/規約メタデータ。
- `operations/`: 構成、依存、環境変数名（値は含めない）、復元ランブック、監査、継承ポリシー。

## 交換可能な基盤構成
Client (Web/iOS/Android) → Auth/Consent → Conversation Orchestrator → Character Engine (versioned profiles and policy) → Memory Service (tenant+character scoped) → Provider Adapters (LLM/TTS/Image/Search).
Backup/Export Service and Audit Log are separate. No external provider is the source of truth for character data. Credentials are in a separate secret manager, not backups of public source.

## 可搬パッケージ (portable bundle)
Versioned manifest.json with schema_version, bundle_id, created_at, asset inventory, paths, sizes, SHA-256 digests, provenance, dependency graph, software/version requirements, privacy classification, encryption metadata, migration history.
Use readable JSON/JSONL/Markdown + lossless media originals, UTF-8, documented schemas and deterministic export order where feasible. Include integrity signature (separate signing key) and offline restore instructions. Encrypt all personal data at rest and in transfer; keep keys outside the exported encrypted payload, with a documented recovery and escrow process. Never place private memories, API keys, or image originals in a public GitHub repository.

## 3-2-1 plus recoverability
Maintain at least 3 copies on 2 distinct media/services, with 1 offline/immutable encrypted copy; include failure-domain separation and periodic retention checks. Suggested roles:
1. Private primary application storage (authoritative live state)
2. Private encrypted offsite backup (e.g., properly access-controlled Drive)
3. Offline encrypted backup under a separate account/device
GitHub holds code, schema, and non-sensitive policy/docs only; not a substitute for encrypted private backups.
Verify checksum after upload and independent readback. Run periodic restore into isolated throwaway environment, compare restored records and character profile hashes, then securely destroy test environment. Track last_verified_at and restore reports. Define RPO/RTO after measuring feasible costs.

## 継承/引き継ぎ
Ownership transfer requires explicit trusted successor designation, estate/legal review, revocable access, two-person checks for sensitive changes, minimum privilege, audit logs, data retention/deletion rights, and access recovery without exposing user secrets to unauthorized people. A successor inherits operations only, not unrestricted access to each user's private data. Users can export/delete their own data; consent remains enforceable after any ownership transition.

## 脅威と対応
Ransomware/deletion → immutable/offline backups and least privilege.
Corrupt exports/schema drift → manifest/checksums/migration tests.
Provider deprecation → adapters and model-switch regression tests.
Insider abuse → audit, separation of duties, review gates.
Prompt injection/hostile AI → source isolation, tool authorization, monitored simulation, deny-by-default write permissions.
Compromised backup keys → rotation/re-encryption and separate recovery material.
Personality drift → reproducible conversation scenario suite comparing stable principles, safety boundaries, and character distinctions.

## 実装順序 / acceptance gates
P0: Inventory actual locations/owners/classification, assess source of truth and current backups (read-only).
P1: Commit schema and manifest examples containing synthetic data only; automated schema tests.
P2: Build export/import offline using synthetic profiles and memories; validate per-user and per-character isolation, no secrets or leaked personal data.
P3: Add encryption, integrity checks, restore drill, backup retention, key recovery, and failure-injection tests.
P4: Add separate backup destinations, independent readback, scheduled restore audits and alarms; only after explicit cost/security approval.
P5: Add successor runbook/legal/access model and test continuity with a restricted role.

A stage passes only with a reproducible restore report; “backup completed” does not imply “recoverable”.
No production data migrations, release changes, PR merges, paid services, external AI calls, or new credentials without explicit authorization.
