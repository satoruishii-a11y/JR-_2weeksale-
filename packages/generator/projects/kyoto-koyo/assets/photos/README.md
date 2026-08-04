# 実写素材の置き場

ここに写真を置いて `prepare-photos` を回すと、手続き的イラストが実写に
差し替わります。**テンプレートも project.json も編集不要**です。

    # 1. このディレクトリに写真を 5 枚置く（jpg / jpeg / png / webp）
    # 2. 各アスペクト比へ切り出す
    npx tsx scripts/prepare-photos.ts --project projects/kyoto-koyo
    # 3. 組版を検証（ffmpeg を回さないので数秒）
    npx tsx src/cli.ts layout --project projects/kyoto-koyo --template editorial-5cut --strategy orthogonal:5
    # 4. 書き出す
    npx tsx src/cli.ts render --project projects/kyoto-koyo --template editorial-5cut --strategy orthogonal:5

`prepare-photos` は `assets/16x9/` と `assets/9x16/` に
`koyo-approach.jpg` `koyo-pagoda.jpg` `koyo-river.jpg` `koyo-window.jpg`
`koyo-alley.jpg` を書き出します。イラスト版と同じ名前なので上書きされます。
イラストに戻したいときは `npm run kyoto-assets` を回し直してください。

## 5 カットの役割

`editorial-5cut` は「引き→引き→中景→寄り→クローズ」で組みます。
どの写真をどのカットに当てるかで印象が変わるので、寄りのカットには
必ず**ディテール（丸窓・手水・灯り・葉の重なりなど）**を入れてください。
全部引きの風景だと単調になります。

| スロット | カット | 求める絵 | テロップ |
|---|---|---|---|
| `koyo-approach` | 1. フック（5拍） | 参道・並木の引き。画面の片側に余白があるもの | 大見出し＋キッカー |
| `koyo-pagoda` | 2. 引き（4拍） | 塔・伽藍・舞台など「京都らしさ」が一目で出る引き | 上部に訴求1 |
| `koyo-river` | 3. 中景（3拍） | 橋・渓谷・水面。**テロップを載せないカット**なので絵だけで持つもの | なし |
| `koyo-window` | 4. 寄り（4拍） | 丸窓・格子・葉の寄り。**画面のどこかに無地の面**があるもの | 左下に訴求2 |
| `koyo-alley` | 5. クローズ（6拍） | 路地・灯り・室内。暗めで、中央にロゴを置ける余白があるもの | ロゴ＋出発期限＋CTA |

## トリミングの指定（任意）

置くだけでも動きますが（既定は中央やや上を残す cover トリミング）、
切れては困る点がある場合は `mapping.json` を置いてください。
`focal` は 0..1 の相対座標で、**そこを切り出し窓の中心に置く**指定です。
`zoom` は 1 より大きいほど寄ります。

    {
      "koyo-approach": { "src": "toji-night.jpg",      "focal": { "x": 0.5,  "y": 0.4  } },
      "koyo-pagoda":   { "src": "kiyomizu-day.jpg",    "focal": { "x": 0.62, "y": 0.32 }, "zoom": 1.15 },
      "koyo-river":    { "src": "bridge-tunnel.jpg",   "focal": { "x": 0.5,  "y": 0.55 } },
      "koyo-window":   { "src": "round-window.jpg",    "focal": { "x": 0.66, "y": 0.36 } },
      "koyo-alley":    { "src": "reflection-room.jpg", "focal": { "x": 0.5,  "y": 0.5  } }
    }

`mapping.json` が無い場合は、ファイル名がスロット名と一致するものを先に当て、
残りは名前順で埋めます。

## 解像度

16:9 は 2400×1350、9:16 は 1560×2772 で書き出します。動画側でさらに
zoompan で 1.6 倍まで寄るため、**長辺 2400px 以上の原版**を置いてください。
足りない場合は拡大率を警告に出します（スクリーンショットからの切り出しは
ここで引っかかりやすい）。

## 注意

- 実在の寺社が写った写真です。**配信するには写真の利用許諾と、施設の撮影・
  掲載許可**が必要です。許諾が取れていない素材で作った書き出しは、社内の
  仕組み検証までに留めてください（社外提出・入稿・SNS 掲載は不可）。
- 架空の事業者名・価格と実在の施設を組み合わせると優良誤認の恐れがあります。
  このテンプレートは組版とカット設計の検証用です。
