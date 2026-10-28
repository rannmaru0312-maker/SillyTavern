# MIYA & KOHARU 共通開発規約

- 作業開始時に本ファイル、docs/AI_DEVELOPMENT_RULES.md、docs/AI_COLLABORATION.md、対象IssueとPR、最新コミットを読む。
- GitHubのIssue・PR・コミット・Checksを引き継ぎ元にする。Work、Copilot、みやの会話記憶が同期していると仮定しない。
- 新規作業は miya-ai-dev から専用ブランチを作り、base=miya-ai-dev のドラフトPRを提出する。PR #2の継続作業だけは miya-ai-dev-iteration-3 を使用する。
- release へのpush、PR、マージ、タグ付けをしない。自動マージと本番デプロイは禁止。
- 本番サーバー、本番記憶、実ユーザーの会話・個人情報、認証情報にはアクセスしない。テストは一時ディレクトリの架空データだけを使う。
- ローカルの隔離した開発checkoutで作業する。ユーザーの本番ディレクトリを使わない。
- 利用者・キャラクター分離、承認前は長期記憶に保存しない挙動、候補100件上限を維持する。仕様変更はIssueに明記する。
- Issueで担当AI、開始SHA、対象範囲を宣言する。同じブランチで複数AIが同時編集しない。push前にremoteを再確認し、force pushしない。
- npm ci --ignore-scripts と npm --prefix tests ci --ignore-scripts で依存を復元する。
- node scripts/miya/check-development.mjs <base-sha> <head-sha>、変更JSへのESLint（--no-ignore）、npm --prefix tests run test:unit -- --runInBand を実行する。
- コミット・PR・Issueに変更内容、検証コマンドと結果、未確認事項、次の担当者向け手順を記載する。秘密値や個人情報を載せない。
- 権限不足、CI未完了、未pushを成功と報告しない。
