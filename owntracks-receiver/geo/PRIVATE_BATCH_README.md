# MIYA & KOHARU — OwnTracks年別Excelの非公開一括更新

本ドキュメントは2026-11-16に検証した試作コードの運用手順。**ChatGPTの毎朝9時タスクへの記述だけで定期実行の成功を保証しない**。本番Render受信サービスへのデプロイはしていない。

## 入出力

- 入力：Google Drive内の本人専用 `生活記録_YYYY.xlsx` の実バイト、 `OwnTracks_受信記録/owntracks_YYYY-MM-DD.json` の実バイト、 SHA256を固定したオフライン町丁目検索バイナリZIP。
- コマンド：`python run-private-diary-sync.py --source 生活記録_2026.xlsx --daily-json owntracks_2026-11-16.json --binary-zip miya-offline-town-geocoder-linux-20261116.zip --year 2026 --output 年別更新候補.xlsx`。日別JSONは `--daily-json` を繰り返して指定できる。
- 出力：`status=updated` の場合のみ新しい更新候補Excel。`status=unchanged` なら生成しない。エラーでは元のExcelに触れない。
- 処理：各日別JSONを **イベントIDとJSON本文のSHA-256、JST日付で検証** → 新規イベントだけを年/月別シートと修正台帳へ追加 → 精度条件を満たす住所空欄レコードに限り町丁目候補をオフライン算出 → 保存コピーのID・修正欄・式・原本の維持を照合。
- 新しい年は対応する `生活記録_YYYY.xlsx` を**別途本人専用で用意**してから処理する。年をまたいだ日別データを誤年のExcelに保存しない。

## セキュリティと本人修正の保護

- GPS座標は外部検索API、GitHub、CI、標準出力、例外メッセージに出さない。子プロセスへは標準入力で送る。
- 店舗名は自動では決めない。町丁目候補は番地・実際の訪問先を保証しない。自宅・仕事先・支援対象者宅も候補は**非公開の年別Excel内のみ**に保持。
- `店舗名の修正` シートの **F列本人修正名**、G/H表示式、I列イベントID、月別A:Q/R:Tを上書きしない。既存住所候補も上書きしない。候補が取得できない点は欠測のまま残す。
- テスト端末ID `TEST` または明示的な合成イベントは取込対象外。異常な端末IDの先頭記号などExcel数式混入疑いは拒否。受信日時はUTCタイムゾーン付きを要求。
- 既存年別ExcelとJSONは不変。更新前にGoogle Drive側で親・非共有・更新時刻・バイトハッシュを確認し、**アップロード直前にも再取得して照合**。競合なら無断更新しない。
- 非共有の「更新前バックアップ」に原本をコピーし、同一DriveファイルIDだけを更新。Google Driveから更新済みファイルを**再取得して実バイトとイベントID・本人修正・年月別件数を照合**して初めて成功を通知。
- Google Driveの同時更新を完全に原子的に防ぐ保証は未確認。変更検知・保留と本人入力保護が必須。初期9時の自動実行に関しては実稼働を別途確認する。

## テスト（架空の公開地点のみ）

```
python test-import-owntracks-day-into-annual.py
python test-annual-offline-town-update.py
python test-run-private-diary-sync.py
```

上記のPythonテストには `artifact_tool` と固定ZIPが必要。GitHub Actionsの標準Python環境に `artifact_tool` があるとは限らないので、CIでは最低限の構文検査とRust/Node側の公開座標テストを実施し、**CI成功だけで完全なExcel処理成功と断定しない**。

## 引き継ぎ

Draft PR #30 の汎用コードを開発正本とし、個人座標・日別JSON・年別Excelの実バイトは非共有Driveと信頼できる私的作業領域に限る。既存タスクの午前9時のスケジュールは維持、重複タスクは作らない。