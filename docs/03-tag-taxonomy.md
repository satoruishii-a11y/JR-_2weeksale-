# 03. タグ体系

タグは2層に分けます。**出どころが違うものを混ぜると、どこまで信用していい数字か分からなくなる**ためです。

| | A層：決定タグ | B層：知覚タグ |
|---|---|---|
| 誰が付けるか | レンダラー | LLM |
| いつ | 生成と同時 | 完成後に1回 |
| 正確さ | 事実。誤りも欠損もない | 推論。ブレる |
| 追加コスト | ゼロ | API費用と処理時間 |
| 主な用途 | **次の生成パラメータに直結** | 意味・印象の解釈 |
| 保存先 | `out/manifests/*.json` | `creative_perception` テーブル |

---

## A層：決定タグ（実装済み）

`out/manifests/<creative_id>.json` の `deterministic_tags` に出ます。
`out/creatives.csv` は同じ内容をフラットにしたもので、そのまま BigQuery / スプレッドシートに入ります。

### 実際の出力例

```json
{
  "creative_id": "sample-2wk_hook-price_08de3b_9x16",
  "variant": { "hash": "08de3b", "axes": { "ctaTiming": "early", "hook": "price", "textStyle": "clean" } },
  "deterministic_tags": {
    "aspect_ratio": "9x16",
    "duration_sec": 14.8,
    "duration_bucket": "15s",
    "scene_count": 4,
    "avg_shot_length_sec": 3.7,
    "cuts_per_10sec": 2.7,
    "pacing": "slow",
    "motion_types": ["zoom-in", "pan-right", "zoom-out"],
    "transition_types": ["fade"],
    "text_overlay_count": 6,
    "total_text_chars": 65,
    "headline_text": "旅の交通費\nまるごと半額",
    "headline_chars": 11,
    "max_font_size_pct": 6.2,
    "first3s_text_chars": 16,
    "first3s_scene_count": 1,
    "hook_type": "price",
    "cta_present": true,
    "cta_text": "「2週間セール」で検索",
    "cta_first_shown_sec": 7.6,
    "cta_position_ratio": 0.514,
    "logo_present": true,
    "bgm_present": true,
    "scrim_used": true,
    "assets_used": ["hero1", "hero2", "hero3", "hero4"],
    "asset_subjects": ["夜行列車の車窓", "海沿いの路線", "山間の紅葉", "駅ホームの朝"],
    "palette": ["#0B5FA5", "#FFD400", "#FFFFFF"],
    "safe_area_violations": 0,
    "text_overflow_warnings": 0
  }
}
```

### フィールドの分類と分析での使いどころ

| 分類 | フィールド | 何を検証できるか |
|---|---|---|
| **形式** | `aspect_ratio` `duration_sec` `duration_bucket` `fps` | 面別・尺別の効率。バンパーとスキッパブルの比較 |
| **編集のリズム** | `scene_count` `avg_shot_length_sec` `cuts_per_10sec` `pacing` | テンポと視聴維持率の関係 |
| **動き** | `motion_types` `transition_types` | 静止画を動かす手法の効き方 |
| **文字量** | `text_overlay_count` `total_text_chars` `max_font_size_pct` | 情報を詰めるべきか削るべきか |
| **冒頭** | `first3s_text_chars` `first3s_scene_count` `hook_type` | **離脱の8割が起きる区間**。最重要 |
| **CTA** | `cta_present` `cta_text` `cta_first_shown_sec` `cta_position_ratio` | CTAを出す秒とCVの関係 |
| **素材** | `assets_used` `asset_subjects` | どの被写体が効くか。次の撮影発注に直結 |
| **配色** | `palette` | ブランド色 vs 強色 |
| **品質** | `safe_area_violations` `text_overflow_warnings` | 入稿前チェック。分析軸ではなく品質ゲート |

### `variant.axes` は最も強い分析軸

`hook` / `textStyle` / `ctaTiming` は**こちらが意図的に振った実験条件**です。
直交配列で均等に配分しているので、他の軸と交絡しません。
「効いた/効かなかった」を最も素直に読めるのはここです。

新しい仮説を検証したくなったら、テンプレートに軸を1つ足します。
軸を足すと組み合わせ数は掛け算で増えますが、`orthogonal:N` は本数を固定したまま
バランスを保つので、**月30本という制約は変えずに検証項目だけ増やせます**。

---

## B層：知覚タグ（LLMが付与・未実装）

### 設計方針：値域を必ず閉じる

自由記述でタグを出させると、`訴求: 価格訴求` `訴求: お得感` `訴求: 割引` が混在して集計不能になります。
**すべての軸を enum で定義し、LLMには「この中から選べ」としか言わせない**のが鉄則です。

新しい値が要ると判断したら、taxonomy のバージョンを上げて**過去分を付け直します**。
値域が途中で変わったまま混在するのが、この種の分析で最も静かに壊れるパターンです。

### タグスキーマ v1（案）

```jsonc
{
  "taxonomy_version": "1.0",

  // ── 訴求（複数可・最大2つ） ──
  "appeal": ["price"],
  // price 価格・割引 / scarcity 期間や数量の限定 / novelty 新しさ
  // authority 実績や権威 / empathy 共感・悩み / benefit 機能的な便益
  // social 第三者の評価 / curiosity 引きや謎かけ

  // ── 冒頭3秒 ──
  "hook_device": "number",
  // number 数字を出す / question 問いかけ / negation 常識の否定
  // scene 情景で引く / face 人物の顔 / motion 動きで引く / text_only テロップのみ
  "hook_clarity": 4,          // 1-5 何の広告か3秒で分かるか
  "first3s_density": "medium", // low / medium / high 情報の詰まり具合

  // ── トーン ──
  "tone": "calm",             // energetic / calm / premium / friendly / urgent / humorous
  "color_impression": "cool", // warm / cool / neutral / high_contrast / muted

  // ── 被写体 ──
  "subject_type": ["landscape"], // person / product / landscape / interior / text_graphic / food / abstract
  "person_present": false,
  "person_face_visible": false,

  // ── 可読性・作り ──
  "text_readability": 5,      // 1-5 背景に文字が負けていないか
  "brand_recall": 3,          // 1-5 誰の広告か分かるか
  "cta_clarity": 4,           // 1-5 次に何をすればいいか分かるか
  "production_feel": "clean", // ugc / clean / cinematic / infographic

  // ── リスク ──
  "risk_flags": [],           // superlative 最上級表現 / unverifiable 根拠不明の数値
                              // medical 医療的示唆 / comparative 他社比較 / none
  "risk_note": null,

  // ── 根拠（人が検算するために必須） ──
  "evidence": {
    "appeal": "0:00-0:04 に「旅の交通費 まるごと半額」と割引率を提示",
    "hook_device": "冒頭カットで「半額」の文字が最大サイズで出る"
  }
}
```

### LLMへの入力の作り方

1本の動画に対して、以下をまとめて渡します。

| 入力 | 作り方 | なぜ必要か |
|---|---|---|
| フレーム画像 | 0.5秒間隔で抽出し、冒頭3秒は0.25秒間隔で密に | 冒頭の判定精度が全体の質を決める |
| コンタクトシート | `--contact-sheet` で生成済み | 時間の流れを1枚で把握させる |
| 音声書き起こし | ナレーションがある場合のみ | 現状のテンプレートはBGMのみなので任意 |
| 決定タグ | manifest をそのまま | **推測させずに済む値を推測させない**ため |

決定タグを一緒に渡すのが要点です。尺やカット数をLLMに数えさせると間違えますし、
そこに使う推論の余力を、判断が必要な軸に回せます。

### 実装上の要件

- **Structured Output（JSON Schema）を必須にする。** 自由テキストをパースしない。
- **`evidence` を必須にする。** 根拠が書けないタグは、だいたい間違っています。
  人がダッシュボードで検算できるようにするための項目でもあります。
- **同一動画には1回だけ実行し、結果を保存する。** LLMの出力は毎回わずかに揺れるので、
  再実行すると過去の集計が変わってしまいます。付け直すのは taxonomy を上げたときだけです。
- **temperature は 0 に近づける。** 創作ではなく分類のタスクです。

---

## 命名規約

- スネークケース。日本語はラベル表示用にダッシュボード側で持ち、データには入れない
- 真偽値は `*_present` / `*_visible`
- 秒は `*_sec`、割合は `*_ratio`（0-1）、パーセントは `*_pct`（0-100）
- 1-5 の主観スコアは接尾辞なし（`hook_clarity` など）。**平均値ではなく分布で見る**こと
- 配列は CSV では `|` 区切り（`zoom-in|pan-right|zoom-out`）

---

## バージョニング

| 対象 | どこに持つか | 上げるとき |
|---|---|---|
| manifest の構造 | `schema_version` | 決定タグのフィールドを追加・改名したとき |
| テンプレート | `template.version` | カット割り・尺・レイアウトを実質変更したとき |
| 知覚タグの語彙 | `taxonomy_version` | enum の値を追加・削除したとき |

テンプレートのバージョンを上げると `variant_hash` も変わります（`docs/02-creative-id.md`）。
これは意図的で、**中身が変わったものを同じIDで比較しない**ためです。
