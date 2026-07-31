# Creative Generator

静止画から YouTube 広告クリエイティブを複数パターン量産するレンダラー。

- **テンプレート**（`templates/*.json`）＝ カット割り・モーション・タイポグラフィ・時間設計。**型**であり自社の資産
- **プロジェクト**（`projects/*/project.json`）＝ 素材・コピー・ブランド色。**中身**であり毎月差し替える

同じテンプレートに違うプロジェクトを流すと別の案件になり、
同じプロジェクトに違うテンプレートを流すと別の型になります。

---

## セットアップ

```bash
npm install
npm run sample-assets   # デモ用のダミー素材を生成
```

ffmpeg は `ffmpeg-static` として入るので個別インストールは不要です。
システムのものを使う場合は `FFMPEG_PATH` を設定してください。

---

## コマンド

```
creative-gen render   --project <dir> --template <id|path> [options]   動画を書き出す
creative-gen layout   --project <dir> --template <id|path> [options]   組版だけ検証（数秒）
creative-gen plan     --project <dir> --template <id|path> [options]   パターン配分を見る
creative-gen validate --project <dir> --template <id|path>             素材と設定の存在チェック
creative-gen templates                                                 テンプレート一覧
```

| オプション | 既定 | 説明 |
|---|---|---|
| `--out <dir>` | `<project>/out` | 出力先 |
| `--strategy <spec>` | `orthogonal:6` | `orthogonal:N` / `sample:N` / `grid[:N]` |
| `--ratios <list>` | `9x16` | `9x16,16x9,1x1,4x5` のカンマ区切り |
| `--seed <string>` | テンプレートID | パターン選択の種。同じ種なら常に同じ組み合わせ |
| `--safe-area <name>` | `instream` | `instream` / `shorts` |
| `--preset <name>` | `medium` | x264 プリセット。下書きは `veryfast` |
| `--crf <n>` | `20` | 画質。小さいほど高画質・大容量 |
| `--concurrency <n>` | コア数-1 | 並列描画数 |
| `--contact-sheet` | off | 冒頭確認用のコンタクトシートも出す |
| `--keep-work` | off | 中間PNGを残す（レイアウト調整時に便利） |
| `--dry-run` | off | 描画せず生成予定の一覧だけ出す |

### 典型的な流れ

```bash
# 1) 設定と素材の存在確認
npx tsx src/cli.ts validate --project projects/sample-2weeksale --template hook-price

# 2) 何本どう振られるか
npx tsx src/cli.ts plan --project projects/sample-2weeksale --template hook-price --strategy orthogonal:6

# 3) 組版チェック（ffmpeg を回さない。ここでコピーを詰める）
npx tsx src/cli.ts layout --project projects/sample-2weeksale --template hook-price \
  --strategy orthogonal:6 --ratios 9x16,16x9,1x1

# 4) 本番書き出し
npx tsx src/cli.ts render --project projects/sample-2weeksale --template hook-price \
  --strategy orthogonal:6 --ratios 9x16,16x9,1x1 --contact-sheet
```

**3 を飛ばさないこと。** コピーが長すぎる／テロップがUIに隠れる、を描画前に潰せます。

---

## 出力

```
out/
  videos/<creative_id>.mp4          入稿するファイル
  videos/<creative_id>.jpg          サムネイル
  videos/<creative_id>-sheet.jpg    コンタクトシート（--contact-sheet 時）
  manifests/<creative_id>.json      決定タグ + 再現用の設計図
  creatives.csv                     manifest をフラットにしたもの（BQ / スプレッドシート用）
  batch.json                        バッチ全体のメタ情報と軸配分
  index.html                        社内レビュー用の静的ページ
```

---

## パターンの選び方（strategy）

| strategy | 挙動 | 使いどころ |
|---|---|---|
| `orthogonal:N` | 各軸の各値が均等に、2軸の組み合わせも広く覆うようN本選ぶ | **既定。分析で要素を切り分けたいなら必ずこれ** |
| `sample:N` | 全組み合わせから決定論的にN本 | とりあえず見た目を確認したいとき |
| `grid` / `grid:N` | 全組み合わせ（Nで上限） | 軸が少なく全部作れるとき |

```
$ npx tsx src/cli.ts plan --project projects/sample-2weeksale --template hook-price --strategy orthogonal:6

オファー訴求15秒（4カット）: 6 パターン × 1 比率 = 6 本

軸 ctaTiming
   early            ■■■ 3
   late             ■■■ 3
軸 hook
   price            ■■ 2
   scarcity         ■■ 2
   question         ■■ 2
軸 textStyle
   clean            ■■■ 3
   impact           ■■■ 3
```

配分が均等なので、`hook=price` の群と `hook=scarcity` の群で
textStyle と ctaTiming の内訳が揃います。差を hook に帰属させられる状態です。

---

## テンプレートDSL

### 全体構造

```jsonc
{
  "id": "hook-price",
  "name": "オファー訴求15秒（4カット）",
  "version": "1.0.0",        // 実質変更したら上げる（creative_id が変わる）
  "fps": 30,
  "hookType": "${axis.hook}", // 決定タグに入るだけ。描画には使わない

  "axes": {                   // 振る実験条件
    "hook": { "description": "冒頭3秒の切り口", "values": ["price", "scarcity", "question"] }
  },

  // このテンプレートが必要とする project.copy のパス。
  // 案件を差し替えたときのコピー漏れを validate が先に検出する
  "requiredCopy": ["kicker", "hook.price", "hook.scarcity", "hook.question", "cta"],

  "audio": { "volume": 0.18, "fadeIn": 0.5, "fadeOut": 1.2 },

  "defs": { /* $ref で使い回す定義。解決後に捨てられる */ },

  "scenes": [ /* カット。時間はシーン先頭からの相対秒 */ ],
  "overlays": [ /* 動画全体に載るもの（ロゴ・CTA）。時間は絶対秒 */ ]
}
```

### 3つのディレクティブ

**1. 文字列補間**

```jsonc
"${axis.hook}"                  // 軸の値
"${ratio}"                      // "9x16" など
"${orientation}"                // portrait / landscape / square
"${copy.benefit1}"              // project.copy から
"${copy.hook.${axis.hook}}"     // 入れ子にできる
"${brand.primary}"              // project.brand から
"${project.campaign}"
```

文字列全体がひとつのトークンなら型が保たれます（数値や真偽値を渡せます）。

**2. `$switch` — 値による分岐**

```jsonc
{ "$switch": { "on": "axis:textStyle", "cases": { "impact": 8.2, "clean": 7.4 } } }
{ "$switch": { "on": "orientation", "cases": { "landscape": 66 }, "default": 82 } }
{ "$switch": { "on": "ratio", "cases": { "9x16": -24 }, "default": -18 } }
```

`on` に取れるのは `axis:<名前>` / `orientation` / `ratio` の3つ。
該当ケースが無ければ `default`、それも無ければエラーになります。

**3. `$ref` — 定義の使い回し**

```jsonc
"defs": {
  "styles": { "headline": { "sizePct": 8.2, "color": "#FFF" } },
  "scrim":  { "kind": "scrim", "side": "bottom", "heightPct": 62, "strength": 0.66 }
},
"scenes": [{
  "overlays": [
    { "$ref": "defs.scrim" },
    { "$ref": "defs.scrim", "heightPct": 100, "side": "full" },  // 兄弟キーで上書きできる
    { "kind": "text", "style": { "$ref": "defs.styles.headline" }, "text": "..." }
  ]
}]
```

### シーン

```jsonc
{
  "id": "hook",                  // 任意。ログとデバッグ用
  "asset": "hero1",              // project.assets の id
  "duration": 4.2,               // 秒
  "motion": "zoom-in",           // still / zoom-in / zoom-out / pan-left / pan-right / pan-up / pan-down
  "motionIntensity": 0.55,       // 0-1。ズーム量とパン量に掛かる
  "transitionIn": "fade",        // 直前シーンからの繋ぎ。scenes[0] では無視される
  "transitionDuration": 0.4,     // 重なる秒。完成尺はこのぶん短くなる
  "grade": { "brightness": -0.06, "contrast": 1.02, "saturation": 0.94, "blurPx": 0 },
  "overlays": [ /* 時間はこのシーンの先頭からの相対秒 */ ]
}
```

`transitionIn` に使えるもの:
`cut` / `fade` / `dissolve` / `wipeleft` / `wiperight` / `slideup` / `slidedown` /
`smoothleft` / `smoothright` / `circleopen` / `fadeblack` / `fadewhite`

### オーバーレイ

4種類あります。共通のプロパティは以下。

```jsonc
{
  "start": 0.2,              // 秒
  "end": 3.0,                // 省略時はシーン末（全体オーバーレイなら動画末）
  "anchor": "bottom-center", // top|center|bottom - left|center|right（"center" 単独も可）
  "xPct": 0, "yPct": -24,    // anchor からのオフセット（キャンバスに対する%。負は上/左）
  "anim": "slide-up",        // none / fade / slide-up / slide-down / slide-left / slide-right
  "animDuration": 0.34,
  "outDuration": 0.25,       // 終わりのフェードアウト秒。0 で出しっぱなし
  "ignoreSafeArea": false
}
```

**`kind: "text"`**

```jsonc
{
  "kind": "text",
  "role": "headline",        // headline / sub / price / cta / note / brand → 決定タグに入る
  "text": "${copy.hook.${axis.hook}}",
  "maxWidthPct": 82,         // レイヤーの外寸（帯の余白と縁取りを含む）
  "maxLines": 2,             // 収まるまで自動で文字を縮める
  "style": {
    "font": "bold",          // project.fonts のキー
    "sizePct": 8.2,          // キャンバス高に対する%
    "minSizePct": 5.0,       // 自動縮小の下限（既定は sizePct の 62%）
    "color": "#FFFFFF",
    "strokeColor": "#141414",
    "strokeWidthPct": 8,     // フォントサイズに対する%
    "lineHeight": 1.32,
    "letterSpacingEm": 0.04,
    "align": "center",
    "band":   { "color": "rgba(18,18,18,0.74)", "paddingXEm": 0.55, "paddingYEm": 0.26, "radiusEm": 0.1, "perLine": true },
    "shadow": { "color": "rgba(0,0,0,0.55)", "blurEm": 0.18, "offsetYEm": 0.06 }
  }
}
```

日本語の折り返しは禁則処理付きです（句読点や閉じ括弧を行頭に置かず、開き括弧を行末に置きません）。

**`kind: "scrim"`** — テキスト可読性のためのグラデーション

```jsonc
{ "kind": "scrim", "side": "bottom", "heightPct": 62, "color": "#000000", "strength": 0.66 }
```

`side` は `bottom` / `top` / `full`。`full` は一様に暗くします。位置は自動なので anchor は不要です。

**`kind: "image"`** — ロゴやバッジ

```jsonc
{ "kind": "image", "role": "logo", "file": "assets/logo.png", "widthPct": 22, "opacity": 0.95 }
```

**`kind: "band"`** — 単色の帯

```jsonc
{ "kind": "band", "widthPct": 100, "heightPct": 12, "color": "${brand.primary}", "radiusPct": 0 }
```

---

## プロジェクト

```jsonc
{
  "slug": "sample-2wk",        // creative_id に入る。英小文字・数字・ハイフンのみ
  "client": "サンプル鉄道（架空）",
  "campaign": "2週間セール",

  "brand": {
    "primary": "#0B5FA5", "accent": "#FFD400",
    "textOnPrimary": "#FFFFFF", "logo": "assets/logo.png"
  },

  "fonts": {
    // 上から順に探して最初に見つかったものを使う
    "default": ["/usr/share/fonts/truetype/fonts-japanese-gothic.ttf", "C:\\Windows\\Fonts\\YuGothB.ttc"],
    "bold":    ["./fonts/NotoSansJP-Bold.otf"]
  },

  "assets": [
    { "id": "hero1", "file": "assets/hero1.jpg", "role": "hero", "subject": "夜行列車の車窓" }
  ],

  "copy": {
    "kicker": "2週間限定",
    "hook": { "price": "旅の交通費\nまるごと半額", "scarcity": "この価格は\nあと2週間だけ" },
    "cta": "「2週間セール」で検索"
  },

  "bgm": "assets/bgm.mp3"
}
```

`assets[].subject`（被写体メモ）は決定タグに入り、
「どの被写体が効いたか → 次の撮影発注」という分析軸になります。書いておくと後で効きます。

`copy` はテンプレートとの契約です。テンプレート側の `requiredCopy` に列挙したパスが
揃っているかを `validate` が確認するので、案件を差し替えたときのコピー漏れは
レンダリング前に分かります。

同じ意味のコピーでも、尺によって入る長さが違う点には注意してください。
同梱の例では 15 秒版が `offer: "8月14日 23:59まで"`、
6 秒版が `offerShort: "8/14 23:59まで"` と別のキーを使っています。
バンパーは文字が大きく行数の余裕が無いためで、
この判断が要るかどうかは `layout` コマンドが教えてくれます。

---

## セーフエリア

配信面で塞がれる領域が違うので、プロファイルで切り替えます。

| プロファイル | 9x16 の想定 |
|---|---|
| `instream`（既定） | 上8% / 右8% / 下16% / 左8%。プレイヤーの操作系だけ避ける |
| `shorts` | 上9% / 右17% / 下22% / 左5%。アクションバーとタイトル帯を避ける |

同梱テンプレートは `instream` で警告ゼロです。
Shorts に出す場合は縦の `defs.width` を 64 前後まで狭め、CTAの `yPct` を −25 程度に下げてください
（右のアクションバーぶん、中央寄せで使える幅が狭くなります）。
コピーも短くする必要があります — `layout` コマンドが具体的に指摘します。

---

## 実装メモ

| 判断 | 理由 |
|---|---|
| テロップは PNG に焼いてから合成 | 日本語の禁則・字間・帯・縁取りを自前で制御するため。drawtext 非搭載ビルドでも動く |
| Ken Burns は 1.6 倍に先読みスケール | zoompan が座標を整数丸めするため、等倍だと1px単位でカクつく |
| チェーン全体を yuv420p で通す | 最終出力が H.264 の 4:2:0。中間だけ 4:4:4 にしても落とされるうえ実測1.5倍遅い |
| BGM が無くても無音トラックを載せる | 音声なしを弾く配信面があるため |
| 並列数の既定はコア数−1 | フィルタグラフがほぼ単スレッドなので、本数を並べたほうが速い |
| 乱数を使わない | 同じ入力から同じ動画が出ること（再現性）を保証するため |

### ソース構成

| ファイル | 役割 |
|---|---|
| `src/types.ts` | zod スキーマと型。アスペクト比とセーフエリアのプリセット |
| `src/resolve.ts` | DSL の解決（`${}` / `$switch` / `$ref`） |
| `src/variants.ts` | 直交配列によるパターン選択、`creative_id` 採番 |
| `src/draw.ts` | 日本語組版とオーバーレイのラスタライズ |
| `src/timeline.ts` | 尺の確定、レイヤー生成、セーフエリア判定 |
| `src/ffmpeg.ts` | filter_complex の組み立てと実行 |
| `src/manifest.ts` | 決定タグの算出、JSON / CSV 出力 |
| `src/review-page.ts` | 社内レビュー用の静的ページ |
| `src/render.ts` | 全体のオーケストレーション |
| `src/cli.ts` | コマンドライン |

```bash
npm run typecheck   # tsc --noEmit
```
