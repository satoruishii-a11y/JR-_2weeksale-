# 02. Creative ID — 動画と実績を紐付ける鍵

この仕組みで最も壊れやすいのは、レンダリングでも分析でもなく
**「どの動画の数字か分からなくなる」** ところです。ここを人手の管理表に頼ると、
月30本×12ヶ月＝360本の規模で必ず破綻します。

対策は単純で、**ID をファイル名と入稿名の両方に埋め込み、機械が突合できるようにする**ことです。

---

## 命名規約

```
<project_slug>_<template_id>_<variant_hash>_<ratio>

例) sample-2wk_hook-price_08de3b_9x16
    │           │          │      └─ アスペクト比
    │           │          └──────── 軸の組み合わせから決まる6桁ハッシュ
    │           └─────────────────── テンプレートID
    └─────────────────────────────── プロジェクト（クライアント×案件）
```

使える文字は英小文字・数字・ハイフン・アンダースコアのみ。
Google Ads のアセット名、YouTube の動画タイトル、ファイル名、URL のどこに置いても壊れません。

### variant_hash の性質

```
sha1("<template_id>@<template_version>|<軸名=値を名前順に連結>").slice(0, 6)
```

- **素材やコピーを差し替えてもハッシュは変わりません。**
  「hook=price / textStyle=impact / ctaTiming=late」という設計上の位置を指すIDだからです。
  8月の `08de3b` と9月の `08de3b` は「同じ型で作った別素材」であり、月をまたいだ型の比較ができます。
- **テンプレートのバージョンを上げるとハッシュは変わります。**
  カット割りを変えたのに同じIDだと、前月との比較が嘘になるためです。
  テンプレートを実質的に変更したら `version` を上げてください。

素材やコピーの違いまで区別したい場合は、`creative_id` ではなく
manifest の `output.sha256`（動画ファイルそのもののハッシュ）を使います。

---

## 入稿時の運用ルール

**運用者が守るのはこれだけです。**

| 入稿先 | 入れる場所 | 例 |
|---|---|---|
| YouTube（動画アップロード） | 動画タイトルの末尾 | `2週間セール_縦_A ［sample-2wk_hook-price_08de3b_9x16］` |
| Google Ads（動画アセット） | アセット名 | `sample-2wk_hook-price_08de3b_9x16` |
| 広告グループ / キャンペーン | 任意（IDは不要） | — |

角括弧で囲むのは、タイトル中からIDを機械的に抜き出しやすくするためです。
Ingestor 側は次の正規表現で拾います。

```
/[a-z0-9-]+_[a-z0-9-]+_[0-9a-f]{6}_(9x16|16x9|1x1|4x5)/
```

### 動画を限定公開でアップロードする場合

広告用に限定公開でアップロードするときも、タイトルにIDを入れる運用は同じです。
YouTube の動画IDは入稿後にしか決まらないので、こちらを正のキーにはできません。
`creative_id` → `youtube_video_id` の対応は Ingestor が初回取得時に記録します。

---

## 突合の流れ

```
① Google Ads API から広告アセットの一覧と実績を取る
      asset.name = "sample-2wk_hook-price_08de3b_9x16"
      metrics    = { impressions, views, view_rate, cpv, conversions, cost }

② asset.name から creative_id を抽出

③ out/manifests/<creative_id>.json（決定タグ）と突き合わせる

④ 一致しなかったものは「未登録クリエイティブ」として警告に出す
```

### ④ を必ず作ること

IDの入れ忘れは必ず起きます。無視すると
「実績はあるのにタグが無いクリエイティブ」が静かに分析から抜け落ち、
気づかないまま歪んだ示唆が出ます。

Ingestor は毎回、次の2つを突合エラーとしてレポートしてください。

- **実績はあるが manifest が無い** → 入稿名のIDが誤り、または手作りの動画が混ざっている
- **manifest はあるが実績が無い** → 入稿漏れ、または配信されていない

前者は数字が歪む原因、後者は「作ったのに出していない」という機会損失です。
どちらも運用側で拾いたい情報なので、ダッシュボードにも出します。

---

## テーブル設計上の位置づけ

`creative_id` はデータモデル全体の主キーです。

```sql
creatives            (creative_id PK, ...決定タグ)
creative_perception  (creative_id FK, ...知覚タグ)
creative_metrics     (creative_id FK, date, ...実績)   -- 日次で積む
creative_retention   (creative_id FK, second, ...維持率)
creative_placements  (creative_id FK, youtube_video_id, ads_asset_id, campaign_id)
```

分析クエリはすべてこのキーでの JOIN になります。
`creative_metrics` だけ日付で持つのは、学習期間の影響や配信初期の変動を分けて見るためです。
