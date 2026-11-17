# MIYA & KOHARU — OwnTracks住所・施設名候補の安全な試作

作成日: 2026-11-16

## 目的
OwnTracksの日時付きGPS観測から住所・店舗名の**候補**を得て、年別生活記録Excelに追記する。ユーザーの修正した店舗名を優先して残す。

## 今回試作したもの
- `place-enrichment.mjs`: 任意の住所検索・周辺店舗検索サービスを接続するための非通信アダプター。初期状態で外部への送信なし。
- `place-enrichment.test.mjs`: 架空の座標・架空の店舗で9つの自動テスト。実際のユーザー・訪問先の座標は使わない。
- GPSの精度が悪い、保護ゾーン、クラウドへの送信に適さない私的地点、未設定API、失敗などは「未取得」「保留」とする。
- 候補名は「自動候補・未確認」として扱い、利用者の手動修正が優先される。

## まだやっていないこと（重要）
- 実際の地図サービスへの接続・ライセンス/料金/使用枠の確定
- iPhone実機へのアプリ導入
- OwnTracks受信サーバーの本番コードへの組み込み
- 定期実行からのGPS候補自動保存／手入力保護の統合検証
- すべての私的な訪問先の住所を外部へ送信する処理（第三者保護の観点から未許可）

したがって、この試作を本番稼働中の「住所・店舗名自動取得」と表現しない。

## 本番化の順序
1. 現状のOwnTracks受信と年別Excelのバックアップを確保。
2. 地図プロバイダーを選び、契約・料金・検索制限・データ保存・機微地点の扱いを検証。Google Geocoding/Placesは請求先とAPIキーが必要。公開Nominatimの大量定期検索を使わない。
3. 支援対象者宅などの保護ゾーンと、その外部送信を制限するポリシーを実装。個人利用でも第三者の住所は慎重に扱う。
4. 検証済み公開スポットのみで検索をテストし、取得元・日時・候補・確度を別列へ記録。
5. 手動で訂正された店舗名を上書きせず、イベントIDと対応させて次回の自動更新で維持。
6. 実バイト読み戻し・差分検証後にのみ「保存成功」とする。

## 起動不要のテスト
```bash
node --test place-enrichment.test.mjs
```
テスト結果 (2026-11-16): 9 passed, 0 failed. 実際の地図API呼び出しは0件。

## 2026-11-16 住所・施設の実プロバイダー接続試作（今回追加）

- `gsi-overpass-provider.mjs`: 日本の国土地理院（GSI）逆ジオコーダーとOSM Overpassの公開施設データに対応する**実HTTPアダプター**。既定は `enabled=false` で外部送信ゼロ。
- `gsi-overpass-provider.test.mjs`: 架空GPS・模擬HTTPを使った自動テスト。**実際の外部APIへの呼び出しは実施していない**。
- GSIは `muniCd`（市区町村コード）と `lv01Nm`（町域名）しか保証しない。`municipalNames` は公式マスタを別途提供する必要があり、現在は「番地までの正確な住所」には非対応。
- OSM/Overpassは周辺の名付きPOIを検索するが、最寄り施設は入店の証拠ではない。近距離に複数候補がある場合は空欄にする。OSMデータに登録がない店舗は返せない。OSMの帰属表示と利用条件を守る。
- 15秒間隔、1回のセッション最大12リクエスト、結果のメモリキャッシュ、タイムアウト、最大返答サイズなどの制限を実装。再起動でキャッシュは消えるので、そのまま定期ジョブで大量使用しない。必要ならDrive等の永続キャッシュとジョブ管理を別途設計する。
- 公開地点の分類と保護エリアの評価は `suggestPlace()` が担当。Cloud経路で検索できるのは **独立確認済みの公開施設・保護ゾーン外**のみ。未知の点・自宅・利用者や第三者の仕事先/支援対象者宅は外部へ送らない。ユーザーの「仕事先も可能なら調べる」希望は、端末側MapKitなど別経路が検証できたときに進める。
- Google Driveの生活記録正本、Render本番、GitHub releaseブランチにはまだ接続・反映していない。本人が修正した店名は常に候補より優先する。

### 接続コードの例（動作確認用・架空地点のみ）
```js
import {suggestPlace} from './place-enrichment.mjs';
import {createGsiOverpassProvider} from './gsi-overpass-provider.mjs';
const provider = createGsiOverpassProvider({enabled: false}); // 本番では必ず false のまま
// true へ変更する前に公開施設の独立検証・保護ゾーン・利用条件と永続キャッシュを実装すること
```

### テスト
```bash
node --test place-enrichment.test.mjs gsi-overpass-provider.test.mjs
```

### 公式資料と注意点
- 国土地理院 gsimaps ソース: https://github.com/gsi-cyberjapan/gsimaps （サーバー側動的機能は仕様変更・長期提供の非保証）
- 国土地理院コンテンツ利用規約: https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html
- Overpass QL: https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL
- Overpass API: https://wiki.openstreetmap.org/wiki/Overpass_API
- OSM copyright/attribution: https://www.openstreetmap.org/copyright
- OSMF公開Nominatimの定期バッチ使用は避ける: https://operations.osmfoundation.org/policies/nominatim/