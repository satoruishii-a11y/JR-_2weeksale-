# YouTube広告クリエイティブ 自動生成・分析基盤

静止画素材から YouTube 広告クリエイティブを複数パターン量産し、
配信実績と要素タグを突き合わせて「何が効いたか」を次の制作に戻す仕組み。

```
作る ──▶ 配信する ──▶ 分析する ──┐
  ▲                              │
  └──── 次月のパラメータに反映 ◀────┘
```

---

## 現在の状態

| ステップ | 状態 |
|---|---|
| **① 作る** | **実装済み** — `packages/generator` |
| ② 配信する | 設計済み（入稿は手動、実績取得を自動化） |
| ③ 分析する | 設計済み |
| ④ ダッシュボード | 設計済み |

「作る」は動きます。サンプル素材から 6パターン × 3アスペクト比 = 18本の生成を確認済みです。

---

## すぐ試す

```bash
cd packages/generator
npm install
npm run demo
```

`npm run demo` はダミー素材を生成してから、6パターン × 3比率 = 18本を書き出します
（4コアで約8分）。終わったら次のファイルをブラウザで開いてください。

```
packages/generator/projects/sample-2weeksale/out/index.html
```

パターンが一覧で並び、軸（フック／テロップ表現／CTAタイミング）でフィルタできます。

短時間で確認したい場合:

```bash
# 組版チェックのみ（ffmpeg を回さないので数秒）
npx tsx src/cli.ts layout --project projects/sample-2weeksale --template hook-price \
  --strategy grid --ratios 9x16,16x9,1x1

# 1本だけ描画
npx tsx src/cli.ts render --project projects/sample-2weeksale --template bumper-6s \
  --strategy sample:1 --ratios 9x16 --preset veryfast
```

---

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | **まずここから。** 全体像と技術選定の理由（なぜFFmpeg自前か、タグ付けをどう分けるか） |
| [docs/01-architecture.md](docs/01-architecture.md) | 3ステップの構成要素とデータの流れ |
| [docs/02-creative-id.md](docs/02-creative-id.md) | 動画と実績を紐付ける鍵。人手の突合をなくす仕組み |
| [docs/03-tag-taxonomy.md](docs/03-tag-taxonomy.md) | 決定タグ／知覚タグの定義と命名規約 |
| [docs/04-analysis.md](docs/04-analysis.md) | LLM分解と示唆出しの設計。少サンプルの扱い |
| [docs/05-dashboard.md](docs/05-dashboard.md) | ダッシュボードの構成とデータモデル |
| [docs/06-operations.md](docs/06-operations.md) | 月次運用フローと工数 |
| [docs/07-roadmap.md](docs/07-roadmap.md) | フェーズ分けと構築見積り |
| [packages/generator/README.md](packages/generator/README.md) | ジェネレーターの使い方とテンプレートDSLの仕様 |

---

## 設計の要点

**月5本の企画を、月30クリエイティブにする。**
1本を6パターンに割ります。追加の撮影も追加の工数もほぼ不要で、
分析に使えるサンプルが6倍になります。月5本ではタグ分析は統計的に成立しません。
「作る」を自動化する最大の理由は、量産そのものではなく分析を成立させることです。

**パターンは直交配列で選ぶ。**
ランダムに選ぶと「速いテンポの動画はたまたま全部黄色いテロップだった」という偏りが混入し、
どちらが効いたか分離できなくなります。各軸の各値が均等に出るよう選ぶことで、
**設計の時点で分析可能性を作り込みます。**

**タグは出どころで2層に分ける。**
生成器が既に知っている値（尺・カット数・文字数・CTA位置）は書き出すだけなので追加コストゼロ、
かつLLMより正確です。LLMは意味・印象の軸に集中させます。
前者があるから、示唆が「次の生成パラメータ」に直接書き戻せます。

**creative_id が全部を束ねる。**
`sample-2wk_hook-price_08de3b_9x16` をファイル名にも入稿名にも入れることで、
動画・タグ・実績が機械的に突き合わさります。運用者が守るルールは
「入稿時に名前へIDを入れる」の1つだけです。

**生成は純粋関数。**
同じ入力からは常に同じ動画が出ます。「先月の当たりの色だけ変えたい」が確実に再現できます。

---

## リポジトリ構成

```
docs/                                 設計ドキュメント
packages/generator/                   ① 作る（実装済み）
  src/                                 レンダラー本体
  templates/                           テンプレート（型）
    hook-price.json                     オファー訴求15秒・4カット
    bumper-6s.json                      バンパー6秒・2カット
  projects/                            案件（素材とコピー）
    sample-2weeksale/
  scripts/make-sample-assets.ts        デモ用ダミー素材の生成
```

素材と生成物は `.gitignore` に入れています。生成物は `creative_id` から常に再生成でき、
素材は権利と容量の都合でリポジトリに置かない方針です。

---

## 動作要件

- Node.js 20 以上
- ffmpeg — `ffmpeg-static` が自動で入るので個別のインストールは不要
  （システムのものを使う場合は環境変数 `FFMPEG_PATH` を設定）
- 日本語フォント — 見つからない場合は `project.json` の `fonts.default` にパスを指定
