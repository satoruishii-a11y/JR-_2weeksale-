# 05. ダッシュボード設計

## 前提

- 自社（横断で見る）とクライアント（自案件のみ）の両方が見る
- データ更新は自動
- 実行環境は後決め。**特定のホスティングやBIに寄りかからない構成にする**

---

## 構成

```
        ┌──────────────────────────────────────────┐
        │ Warehouse                                 │
        │  creatives / creative_perception /        │  ← ここが唯一の正
        │  creative_metrics / creative_retention    │
        └───────▲───────────────────────▲──────────┘
                │ 日次で書く              │ 読む
     ┌──────────┴─────────┐   ┌──────────┴──────────┐
     │ Jobs               │   │ Dashboard (Next.js) │
     │  ads-ingest        │   │  内部ビュー / 顧客ビュー│
     │  retention-ingest  │   └─────────────────────┘
     │  llm-tag           │
     │  insight-build     │              ┌─────────────────┐
     └────────────────────┘              │ 動画・サムネ配信  │
                                         │ (オブジェクトストレージ)│
                                         └─────────────────┘
```

### 技術選定

| 層 | 選定 | 理由 |
|---|---|---|
| Warehouse | **Postgres**（Supabase / Cloud SQL）で開始 | 月30本×12ヶ月で年4千行程度。BigQueryが必要な規模ではない。行レベルセキュリティでクライアント分離をDB側に寄せられる |
| UI | **Next.js (App Router)** | 動画プレビュー・タグ別スコア・示唆コメントを1画面に置く自由度。BIツールでは表現しきれない |
| ジョブ | Node のスクリプト＋cron | Vercel Cron / Cloud Scheduler / GitHub Actions のどれでも動く形にしておく |
| 動画配信 | S3 / GCS / R2 + 署名付きURL | クライアントごとにアクセスを絞る |
| 認証 | メールリンク or SSO | クライアントに管理させるパスワードを増やさない |

**Postgres で始めて BigQuery に移せる形にしておくこと。**
分析クエリを標準SQLで書き、アプリのロジックにDB固有機能を持ち込まなければ移行は容易です。
逆にスプレッドシートを正のデータ置き場にすると、後で必ず詰まります。

Looker Studio を併用したい場合は、Warehouse に読み取り専用で繋いで
「数字の一覧」だけを担当させ、動画プレビューと示唆は Next.js 側に残すのが現実的です。

---

## データモデル

```sql
-- 生成時に確定するもの（manifest.json をそのまま入れる）
CREATE TABLE creatives (
  creative_id        TEXT PRIMARY KEY,
  client_id          TEXT NOT NULL REFERENCES clients(client_id),
  campaign           TEXT NOT NULL,
  template_id        TEXT NOT NULL,
  template_version   TEXT NOT NULL,
  variant_hash       TEXT NOT NULL,
  variant_axes       JSONB NOT NULL,          -- {"hook":"price","textStyle":"clean",...}
  aspect_ratio       TEXT NOT NULL,
  duration_sec       NUMERIC NOT NULL,
  deterministic_tags JSONB NOT NULL,          -- 決定タグ一式
  video_url          TEXT,
  thumbnail_url      TEXT,
  generated_at       TIMESTAMPTZ NOT NULL
);

-- LLMが付ける知覚タグ（1クリエイティブ1行・付け直し時のみ更新）
CREATE TABLE creative_perception (
  creative_id      TEXT PRIMARY KEY REFERENCES creatives,
  taxonomy_version TEXT NOT NULL,
  tags             JSONB NOT NULL,
  evidence         JSONB NOT NULL,
  model            TEXT NOT NULL,
  tagged_at        TIMESTAMPTZ NOT NULL
);

-- 入稿の対応表（実績突合の要）
CREATE TABLE creative_placements (
  creative_id      TEXT REFERENCES creatives,
  youtube_video_id TEXT,
  ads_asset_id     TEXT,
  campaign_id      TEXT,
  ad_group_id      TEXT,
  first_seen_at    TIMESTAMPTZ,
  PRIMARY KEY (creative_id, ads_asset_id)
);

-- 日次実績
CREATE TABLE creative_metrics (
  creative_id  TEXT REFERENCES creatives,
  date         DATE,
  impressions  BIGINT, views BIGINT, view_rate NUMERIC,
  p25_rate NUMERIC, p50_rate NUMERIC, p75_rate NUMERIC, p100_rate NUMERIC,
  clicks BIGINT, ctr NUMERIC,
  conversions NUMERIC, cost NUMERIC, cpv NUMERIC,
  PRIMARY KEY (creative_id, date)
);

-- 秒単位の視聴維持率
CREATE TABLE creative_retention (
  creative_id  TEXT REFERENCES creatives,
  second       INT,
  watch_ratio  NUMERIC,
  PRIMARY KEY (creative_id, second)
);

-- 突合できなかったものを溜める（無視すると分析が静かに歪む）
CREATE TABLE ingest_anomalies (
  detected_at TIMESTAMPTZ, kind TEXT,   -- 'metrics_without_manifest' | 'manifest_without_metrics'
  ref TEXT, detail JSONB
);
```

`client_id` を `creatives` に持たせ、行レベルセキュリティで
「クライアントユーザーは自分の `client_id` の行しか読めない」を **DB側で** 保証します。
アプリ側の `WHERE` 句だけに頼ると、いつか漏れます。

---

## 画面

### 共通（自社・クライアント両方）

**1. クリエイティブ一覧**
サムネイル格子。クリックでインライン再生。カードに主要KPIとバリアント軸のチップ。
比率・テンプレート・軸・期間でフィルタ。
※ 生成直後のレビューは、実装済みの `out/index.html` が同じ役割を担います。

**2. 要素別パフォーマンス**
タグごとに「本数・VTR・CPV・CV・全体との差」を並べ、
`docs/04-analysis.md` の基準で **参考値／傾向／示唆／知見** のバッジを自動で付けます。
バッジはデータ量から機械的に決まるので、書き手の匙加減が入りません。

**3. 視聴維持率カーブ**
複数クリエイティブを重ねて表示。冒頭5秒を横軸で拡大できるようにします。
`hook_device` や `first3s_text_chars` で色分けすると、冒頭設計の良し悪しが目で分かります。

**4. 月次サマリー**
`insight-build` ジョブが生成したレポート。結論／根拠の数字／次月のパラメータ／保留事項。
**「判断を保留したもの」を必ず表示します。**

### 自社のみ

**5. 横断ビュー** — 全クライアントを通したテンプレート別の勝率。テンプレート資産の評価に使う
**6. 制作キュー** — 今月の生成予定・レンダリング状況・入稿状況
**7. 異常検知** — `ingest_anomalies` の一覧。IDの入れ忘れ、入稿漏れ
**8. 品質ゲート** — `safe_area_violations` / `text_overflow_warnings` が残っているクリエイティブ

### クライアント向けの配慮

- 用語を出さない。「VTR」→「最後まで見られた割合」のように言い換える
- **勝ち負けだけでなく「次に何を試すか」を必ず出す。** 悪い数字だけを見せない
- 数字の裏付けが弱い項目は「傾向」バッジで明示する。断定を避けるのは信頼のためです
- PDF / 画像でのエクスポート（社内報告に転用されるため）

---

## 自動更新

| ジョブ | 頻度 | 内容 |
|---|---|---|
| `ads-ingest` | 日次 06:00 | Google Ads API から前日分を取得。`creative_id` で突合。異常は `ingest_anomalies` へ |
| `retention-ingest` | 日次 06:30 | YouTube Analytics から秒単位維持率を取得 |
| `llm-tag` | 生成後 / 手動 | 未タグ付けのクリエイティブに知覚タグを付ける |
| `insight-build` | 月次 + 手動 | 集計SQL → LLMで言語化 → 月次サマリーを保存 |

- 全ジョブを**冪等**にします（同じ日を2回流しても壊れない）。`ON CONFLICT DO UPDATE` で書きます。
- APIのクォータ超過とタイムアウトは指数バックオフで再試行します。
- 失敗はSlackに通知します。**静かに失敗して数字が古いまま、が最悪のケースです。**
  ダッシュボードには最終更新時刻を常時表示して、古いデータを見ていることに気づける状態にします。
