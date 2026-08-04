# 実写素材の置き場

`editorial-5cut` テンプレートが参照するファイル名です。ここに置いてください。

| ファイル名 | 内容 | 役割 |
|---|---|---|
| `toji-night.jpg` | 東寺の五重塔・夜間ライトアップ＋池の反射 | フック |
| `kiyomizu-day.jpg` | 清水寺の舞台＋紅葉（曇天） | 引き |
| `bridge-tunnel.jpg` | 赤い橋＋紅葉のトンネル（順光） | 中景 |
| `round-window.jpg` | 丸窓（悟りの窓）＋紅葉 | 寄り／ディテール |
| `reflection-room.jpg` | 書院の映り込み（暗い室内） | クローズ |

置いたら次で確認できます。

    npx tsx src/cli.ts validate --project projects/kyoto-koyo --template editorial-5cut
    npx tsx src/cli.ts layout   --project projects/kyoto-koyo --template editorial-5cut

## 注意

- 実在の寺社が写った写真です。**配信するには写真の利用許諾と、施設の撮影・掲載許可**が必要です。
- 架空の事業者名・価格と実在の施設を組み合わせると優良誤認の恐れがあります。
  このテンプレートは組版とカット設計の検証用です。
