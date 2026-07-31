# SGTM案件 一次調査メモ（社内）

ソースネクスト様 SGTM構築・移行支援 / 2026-08-03 MTG 準備
作成 2026-07-31 ／ 対象タスク＝引き継ぎメモ「社内タスク（未確定）」のうち机上で確認可能な項目

> **この文書の位置づけ**：すべて二次情報（ベンダー公開情報・技術ブログ・媒体公式ドキュメント）に基づく一次調査。
> 金額・仕様は見積根拠として使う前に一次確認（媒体担当・ベンダー営業）が必要。確度は各項目に明記した。
> **クライアント提示可否も各項目に明記**。社内語・断定調のまま先方に出さないこと。

---

## 0. 結論サマリ（先に読む用）

| # | 論点 | 調査結果 | 8/3への影響 |
|---|---|---|---|
| 1 | Yahoo!広告のサーバーサイド対応 | **CAPIは2025-09-10提供開始済み。ただしバッチ前提でsGTMリアルタイム転送の設計ではない** | **SGTMスコープから切り出す**。期待値ギャップの芽はここ。持ち帰らず当日整理して説明可 |
| 2 | Criteo | **Criteo公式のsGTMタグテンプレートあり**（GitHub） | 対応可と言える。ただしCriteo側で`applicationId`発行手続きが必要 |
| 3 | RTB House | Conversions APIタグあり（Stape提供＝サードパーティ） | 実装可。公式提供ではない点は伏せない |
| 4 | **Bing（Microsoft広告）** | **UET CAPIをsGTMから送信可。ただし`msclkid`のサイト側取得・保持が必須前提** | **メモの未検証リストに入っていなかった。費用24-27%＝最重要媒体。Step 0の必須調査項目に追加** |
| 5 | ホスティング費用 | Stape 4段階（〜20Mreq/月で$200）／Addingwellは1Mreq/月で約€80〜、以降要見積／Cloud Runは2インスタンス常時で**月$90-98がフロア**、高負荷時$240-300 | 金額を口にしない方針は維持。ただし**リクエスト数の桁**は当日示せる |
| 6 | 想定リクエスト数 | 300万セッション/月 → **月1,500万〜4,500万リクエスト** | Stape最上位20Mでも不足しうる＝要問い合わせ帯。「月数千円事例は当てにならない」を数字で裏付け |

**8/3のアジェンダに効く最大の発見は2つ**：Yahooは別ワークストリームに切り出すべきこと、そしてBingが未検証リストから漏れていたこと。

---

## 1. 媒体別サーバーサイド対応マトリクス

引き継ぎメモの媒体構成（Google / Bing / Yahoo / Criteo / RTB House / Meta）を全数で確認した。

| 媒体 | sGTM対応 | 経路・テンプレート提供元 | 前提条件（見落とし注意） | 確度 |
|---|---|---|---|---|
| **Google**(Ads/GA4) | ◎ | Google公式・sGTM標準搭載 | — | 確実 |
| **Meta** | ◎ | Conversions API。公式/Stape両方に定番テンプレート | — | 確実 |
| **Criteo** | ◎ | **Criteo公式GitHub** `criteo/sgtm-criteo-tag-s2sv2` | ①web側に`gtm-criteo-client-s2sv2`併設 ②`Criteo User Identification`をweb側に設置 ③**`applicationId`をCriteo担当者から取得** | 高（要Criteo手続き） |
| **RTB House** | ○ | RTB House Conversions APIタグ（**Stape提供＝サードパーティ**） | pageview/product/basket/conversion/consent withdrawalをカバー | 中〜高 |
| **Bing**(Microsoft) | ○ | Microsoft Ads CAPI。**Stape提供**のMicrosoft UET Conversion APIタグ、または独自タグ | **`msclkid`をLPのURLから取得しサーバーへ引き渡すことがクリック帰属の必須要件**。加えてユーザーマッチング/リマケにはclient-side IDシンクビーコンが必要 | 中〜高 |
| **Yahoo!広告** | **△（別アーキ）** | 検索広告CAPI（2025-09-10提供開始）／ディスプレイ広告コンバージョン計測APIは**β版** | **下記1-1参照。sGTMからのリアルタイム転送は想定外** | 中（要一次確認） |

### 1-1. Yahoo!広告が「別扱い」になる理由 ★重要

確認できた仕様：

- 提供開始：**2025年9月10日**（検索広告）。ディスプレイ広告側は**β版**
- **バッチ処理による定期連携が前提**。「毎日深夜に前日分のコンバージョンを送信する」運用が一般的
- レート制限 **50リクエスト/秒**
- 管理画面反映は**非同期**。数分〜数時間、場合により翌日
- 紐づけキーは **`yclid`**（クリック時にURLパラメータとして付与される識別子）

→ つまりYahoo CAPIは**「後付けコンバージョン計測・オフラインCV連携」の道具**であり、
sGTMがヒットを受けて即座に媒体へ転送するアーキテクチャとは設計思想が違う。
月300万セッション規模のリアルタイム転送を50req/sの窓に通す発想自体が噛み合わない。

**これは案件にとって悪いニュースではない。**
Yahooは「Snowflakeの実注文を正解にして日次バッチでCAPI送信」が正しい設計であり、
それは引き継ぎメモに書かれたatarayoの差別化（Snowflake実注文を正解に置く）と完全に同じ方向を向いている。
提案上は**SGTM（リアルタイム）とYahoo CAPI（日次バッチ）を別ワークストリームとして分けて見せる**のが誠実かつ有利。

日本市場ではYahoo CAPIはETL/連携ツール経由の事例が主（TROCCO、DATA CONTROL、KARTE Signals等）。
sGTM公式テンプレートは確認できなかった。**「無い」と断定する前に一次確認は必要**（→ 3章）。

### 1-2. Bingが未検証リストから漏れていた件 ★重要

引き継ぎメモの注意点は未検証媒体を「Yahoo/Criteo/RTB House」としているが、**Bingが入っていない**。
一方でクライアント前提には「Bingが費用24-27%と異例に厚い」と書かれている。
**費用比率で2番目以下に厚い媒体が検証対象から漏れている**状態だった。

調査の結果、技術的には対応可。ただし**`msclkid`の取得・保持がクリック帰属の必須要件**であり、
これは「サーバーコンテナを建てれば済む」話ではなく**サイト側（web GTM／LP）の仕込みが必要**。
同様にYahooも`yclid`が必要。

→ **Step 0（現状棚卸し）の必須確認項目に追加すべき**：
「`msclkid` / `yclid` / `gclid` が現在サイト側で取得・保持されているか、保持期間はどれだけか」
ここが無いと、SGTMを建てても Bing / Yahoo のCVは紐づかない。回収できる上限値の見積りが変わる。

---

## 2. ホスティング費用（案1 マネージドSaaS ／ 案2 Cloud Run自社構築）

### 2-1. まずリクエスト数の桁を押さえる ★これが費用の全部を決める

**課金単位はセッション数ではなくリクエスト（イベント）数**。ここを取り違えると桁を間違える。

```
前提：3Q KPI 10.2Mセッション → 月間約300万セッション
GA4の1セッションあたりイベント数を 5〜15 と置くと（EC・回遊多めなら上振れ）

  300万セッション × 5イベント  = 月 1,500万リクエスト
  300万セッション × 10イベント = 月 3,000万リクエスト
  300万セッション × 15イベント = 月 4,500万リクエスト
```

→ **月1,500万〜4,500万リクエストのレンジ**。
引き継ぎメモの「月数千円事例は当てにならない」は正しく、かつこの桁が理由。
**Stapeの最上位公表プラン（20Mreq/月）でも足りない可能性がある**＝両ベンダーとも要問い合わせ帯に入る。

> 8/3で1つ確認したい：**1セッションあたりのGA4イベント数**。
> これはGA4の既存データから即出せる（イベント数 ÷ セッション数）。Step 0の最初の1本にすべき。
> ここが確定しないと費用レンジが3倍ぶれる。

### 2-2. Stape（案1候補）

公表4段階（月額。**年払いで20%オフ**＝下段の数字）：

| プラン | 月額 | 年払い換算 | 含まれるリクエスト/月 |
|---|---|---|---|
| Personal / Free | $0 | — | 10,000 |
| Pro | $20 | 約$17 | 500,000 |
| Business | $100 | 約$83 | 5,000,000 |
| Enterprise | $200 | 約$167 | 20,000,000 |

- 20M超は公表なし＝**要問い合わせ**（本件はここ）
- 別途、Gateway系プロダクト（Stape Gateway / Meta CAPI / TikTok / Snapchat）は**ゲートウェイ単位の別課金**。ピクセル数・ドメイン数連動
- ISO 27001:2022 / 9001:2015 / GDPR / HIPAA 準拠、EUホスティング可
- 80+テンプレート同梱。**本件で必要なMicrosoft UET CAPI・RTB House CAPIのテンプレート提供元がStape**である点は案1採用の実利になる

> 出典間で$20/$100/$200と$17/$83/$167の2系統があり混乱しやすいが、**後者は年払い20%オフ後の月額換算**と解釈すると整合する。見積書では月払い基準で書くこと。

### 2-3. Addingwell（案1候補）

- 無料サンドボックス：**10万リクエスト/月**
- 有料：**約€80/月で約100万リクエスト/月**、エントリーで€90/月・200万クエリ
- **それ以上のレート・クォータは非公開＝要見積もり**（本番利用は営業経由が前提）
- 超過分は請求サイクル末に計算され請求に含まれる
- **課金は incoming request のみ**。1イベントを4媒体に配っても**1リクエスト**として課金

> **本件ではこの課金方式が効く可能性がある。**媒体6つに配信する構成なので、
> outgoing課金のベンダーと比べて有利に出る余地がある。案1を2社比較する際の主要な軸にすべき。

### 2-4. Cloud Run（案2）

| 費用項目 | 単価・目安 |
|---|---|
| リクエスト | **$0.40 / 100万リクエスト**（無料枠 200万リクエスト/月） |
| 1インスタンス常時稼働（1vCPU / 0.5GiB、CPU常時割当） | **約 $49 / 月** |
| **推奨最小構成＝2インスタンス**（コールドスタート回避＋冗長性） | **約 $90〜98 / 月がフロア** |
| 高トラフィックでオートスケール5〜6インスタンス | **$240〜300 / 月** |
| スループット目安 | 2〜10インスタンスで**約35〜350 req/s**（コンテナ内のタグ数で変動） |
| **ログ** | **月100万リクエストを超えると課金対象**。ログルーターで手動停止しないと請求が静かに膨らむ |

本件のスループット所要（概算）：

```
月3,000万リクエスト ÷ 2,592,000秒 ≒ 平均 11.6 req/s
ピークを平均の5〜10倍と置くと 約58〜116 req/s
→ 上記目安（2〜10インスタンスで35〜350 req/s）に照らし、
   ピーク時 4〜8インスタンス程度を見込む構成
→ インフラ費は月$200〜400程度のレンジに入る想定（+ログ・下り通信）
```

**案2の注意点（先方に正直に言う材料）**：
- リクエスト課金自体は安い（3,000万req ≒ $11）。**費用の主役はインスタンス常時稼働費**
- **ログ課金の停止漏れが典型的な事故**。運用手順に明記が必要
- 常時割当・最小インスタンス・同時実行数のチューニングが前提知識を要する＝**運用保守費に跳ねる**

### 2-5. 案1 vs 案2 の整理（先方に選ばせる形にする）

| 軸 | 案1 マネージドSaaS | 案2 Cloud Run自社構築 |
|---|---|---|
| 月額インフラ費の桁 | 要見積もり帯（20M超） | 月$200〜400のレンジ想定 |
| 立ち上げ速度 | 速い | 遅い（GCP設定・DNS・監視の作り込み） |
| 必要テンプレート | **Microsoft UET CAPI / RTB House CAPI が同梱**（Stape） | 同テンプレートを個別に持ち込む必要あり |
| データの所在 | ベンダー基盤 | **先方GCP内**（1stPartyデータ志向・Snowflake併用と親和） |
| 運用の主体 | ベンダーが吸収 | **先方または atarayo が監視責任を持つ** |
| 契約 | ベンダー直契約推奨 | GCP直契約 |
| 中長期 | 乗り換えコストが発生 | **SNの志向に合う（引き継ぎメモの見立て通り）** |

引き継ぎメモの「先方の志向は中長期で案2寄り」は妥当。
ただし**Step 3の並行稼働までは案1で始めて、切替完了後に案2へ移す**という段階案も成立する。
テンプレート同梱の利点が効くのは並行稼働期なので、そこだけSaaSを使う判断はありうる。**8/3では出さず社内で先に検討**。

---

## 3. 一次確認が必要な残タスク（この調査では確定できなかったもの）

| # | 内容 | 確認先 | 期限 | 8/3をブロックするか |
|---|---|---|---|---|
| 1 | Yahoo!広告CAPIのsGTM対応可否の公式見解、ディスプレイβ版の提供条件 | LINEヤフー / 代理店 | 8/3前が理想 | **しない**（バッチ前提と整理して説明できる） |
| 2 | Microsoft広告 UET CAPI の公式仕様と`msclkid`要件の詳細 | Microsoft広告 / 代理店 | 8/3前が理想 | しない |
| 3 | Criteo `applicationId` 発行手続きとリードタイム | Criteo担当者（代理店経由の可能性） | Step 1まで | しない |
| 4 | Stape 20Mreq超の価格 | Stape営業 | 見積提出前**必須** | しない（金額は口にしない方針） |
| 5 | Addingwell 本番プラン価格 | Addingwell営業 | 見積提出前**必須** | しない |
| 6 | GA4「1セッションあたりイベント数」の実測 | **GA4既存データ。自社で即出せる** | **8/3前に出したい** | しない（が、あると精度が上がる） |
| 7 | 金額レンジ | **加藤さん** | 8/3前 | **する** |
| 8 | 月額サポート枠にSGTM運用を含められるか | **契約書確認** | 8/3前 | **する** |

→ **8/3を実質ブロックするのは #7 #8（社内確認）のみ**。技術面の未検証は当日の説明で処理できる状態になった。

---

## 4. 引き継ぎメモへの反映提案

調査を踏まえて、既存ドキュメント（`handoff_sgtm.md` / `202607_sgtm_migration_plan.md`）に入れたい修正。

1. **未検証媒体リストを修正**
   「Yahoo/Criteo/RTB Houseは未検証」→
   Criteoは公式テンプレート確認済み／RTB Houseはサードパーティで実装可／**Bingを検証対象に追加**／
   **Yahooは未検証ではなく「アーキテクチャが別」と再定義**

2. **Step 0の棚卸し項目に追加**
   - `gclid` / `msclkid` / `yclid` の**サイト側での取得・保持状況と保持期間**
   - **GA4の1セッションあたりイベント数**（費用レンジの根幹）

3. **工程スコープの分割**
   SGTM本線（Google/Meta/Criteo/RTB House/Bing：リアルタイム）と
   **Yahoo CAPI（Snowflake起点の日次バッチ）を別ワークストリーム**として提案書上で分離

4. **8/3で必ず聞く6点に追加**
   現行6点（コンテナ所有者／DNS担当とリードタイム／ドメイン構成／媒体優先順位／本命目的／監視主体）に加えて：
   - **Yahoo・Bingの計測をどこまで本件スコープに含める想定か**
     （Yahooがバッチ別建てになる前提を早期に共有し、期待値を先に揃える）

5. **費用3層の書き方**
   インフラ費の説明に**「課金単位はセッション数ではなくイベント数」**を明記。
   ここを先方と揃えておかないと、後で見積の桁について認識差が出る。

---

## 出典

**媒体のサーバーサイド対応**
- [criteo/sgtm-criteo-tag-s2sv2（Criteo公式）](https://github.com/criteo/sgtm-criteo-tag-s2sv2) ／ [criteo/sgtm-criteo-tag](https://github.com/criteo/sgtm-criteo-tag) ／ [criteo/gtm-criteo-client-s2sv2](https://github.com/criteo/gtm-criteo-client-s2sv2)
- [Criteo - sGTM Tag Template（Stape）](https://feature.stape.io/posts/88/criteo-sgtm-tag-template)
- [RTB House Conversions API for GTM Server-Side（Stape Community）](https://community.stape.io/t/rtb-house-conversions-api-for-google-tag-manager-server-side/4187)
- [How to track Bing Ads conversion events using server side GTM（Microsoft Q&A）](https://learn.microsoft.com/en-us/answers/questions/1659899/how-to-track-bing-ads-conversion-events-using-serv)
- [Is it possible to setup Microsoft/Bing Ads server-side tracking?（Stape Community）](https://community.stape.io/t/is-it-possible-to-setup-microsoft-bing-ads-server-side-tracking/2520)
- [Microsoft Ads UET Tag Implementation（DataCops）](https://joindatacops.com/resources/microsoft-ads-uet-tag-implementation-a-complete-guide/)
- [Server-side tagging 概要（Google公式）](https://developers.google.com/tag-platform/tag-manager/server-side/overview)

**Yahoo!広告 CAPI**
- [Yahoo!検索広告でコンバージョンAPIの提供開始（PLAN-B, 2025/08）](https://www.plan-b.co.jp/blog/ad/83068/)
- [Yahoo!検索広告でもコンバージョンAPIが可能に（Infinity-Agent Lab）](https://infinity-agent.co.jp/lab/ysa_cv-api/)
- [Yahoo!広告 検索広告コンバージョンAPI 後付けCV計測・オフラインCV連携の実践ガイド（primeNumber）](https://primenumber.com/blog/yahoo-search-ads-conversion-api/)
- [Yahoo!広告ディスプレイ広告コンバージョン計測API(β版)（TROCCO Docs）](https://documents.trocco.io/docs/data-destination-yahoo-display-ads-conversion-api)
- [LINEヤフー広告 検索広告のコンバージョンを補完する（KARTE Signals）](https://support.karte.io/post/32MfoVLn6C5HGRqqmUI0LR)
- [DATA CONTROL、Yahoo!広告 Conversion APIとの接続開始（ソウルドアウト）](https://prtimes.jp/main/html/rd/p/000000317.000031201.html)

**ホスティング費用**
- [Plan Tiers and Limits（Stape公式）](https://stape.io/helpdesk/documentation/plan-tiers-and-limits)
- [stape.io Pricing 2026（G2）](https://www.g2.com/products/stape-io/pricing) ／ [Stape Pricing（SaaSworthy）](https://www.saasworthy.com/product/stape-io/pricing)
- [Server-Side GTM Cost in 2026: Cloud Run, Stape, Addingwell](https://alexisvantal.com/articles/server-side-gtm-cost/)
- [Server-Side Tracking Pricing Comparison 2026（SignalBridge）](https://www.signalbridgedata.com/blog/server-side-tracking-pricing-comparison)
- [Stape vs Google Cloud - GTM Server Costs（Analyzify）](https://analyzify.com/hub/google-cloud-run-vs-stape-pricing)
- [Stape vs Addingwell（DataCops）](https://joindatacops.com/resources/stape-vs-addingwell/)
- [Cloud Run pricing（Google公式）](https://cloud.google.com/run/pricing)
- [Optimizing Server-side Tagging Cost（Hardal）](https://medium.com/usehardal/server-side-tagging-cost-b5cd984583b0)
