/**
 * assets/photos/ に置いた実写を、テンプレートが参照する
 * assets/<ratio>/<slot>.jpg へ切り出す。
 *
 * 手続き的イラストを実写に差し替えるための入口。project.json の
 * asset.file は `assets/${ratio}/koyo-approach.jpg` のような形なので、
 * このスクリプトが同じ名前で書き出せば、テンプレートも project.json も
 * 触らずに素材だけ入れ替わる。
 *
 *   npx tsx scripts/prepare-photos.ts --project projects/kyoto-koyo
 *
 * 割り当ては assets/photos/mapping.json で決める（無ければファイル名の
 * stem 一致 → 見つからなければ並び順）。焦点（focal）は 0..1 の相対座標で、
 * トリミングでどこを残すかを指定する。人物の顔や塔の頂点など、切れては
 * 困る点を置く。
 *
 *   {
 *     "koyo-approach": { "src": "toji-night.jpg", "focal": { "x": 0.5, "y": 0.4 } },
 *     "koyo-pagoda":   { "src": "kiyomizu-day.jpg", "focal": { "x": 0.62, "y": 0.35 }, "zoom": 1.15 }
 *   }
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadImage } from '@napi-rs/canvas';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);

/** イラスト版と同じ出力サイズ。ここを変えると全カットの解像度が変わる */
const TARGETS = [
  { ratio: '16x9', width: 2400, height: 1350 },
  { ratio: '9x16', width: 1560, height: 2772 },
] as const;

/** project.json が参照しているスロット。順番は「引き→引き→中景→寄り→クローズ」 */
const SLOTS = [
  'koyo-approach',
  'koyo-pagoda',
  'koyo-river',
  'koyo-window',
  'koyo-alley',
] as const;

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

type Focal = { x: number; y: number };
type SlotSpec = { src: string; focal?: Focal; zoom?: number };
type Mapping = Record<string, SlotSpec>;

function parseArgs(argv: string[]): { project: string; quality: number } {
  let project = '';
  let quality = 92;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') project = argv[++i] ?? '';
    else if (argv[i] === '--quality') quality = Number(argv[++i]);
  }
  if (!project) {
    console.error('使い方: npx tsx scripts/prepare-photos.ts --project projects/kyoto-koyo');
    process.exit(1);
  }
  return { project, quality };
}

async function readMapping(photosDir: string): Promise<Mapping> {
  const file = path.join(photosDir, 'mapping.json');
  if (!existsSync(file)) return {};
  const raw = JSON.parse(await readFile(file, 'utf8')) as Mapping;
  for (const [slot, spec] of Object.entries(raw)) {
    if (!spec?.src) throw new Error(`mapping.json: ${slot} に src がありません`);
  }
  return raw;
}

/**
 * スロットへ写真を割り当てる。mapping.json が最優先、次にファイル名の
 * stem 一致（koyo-approach.jpg を置いた場合）、最後に並び順のフォールバック。
 */
function assign(slots: readonly string[], photos: string[], mapping: Mapping): Map<string, SlotSpec> {
  const out = new Map<string, SlotSpec>();
  const remaining = [...photos];

  const take = (name: string): string | undefined => {
    const i = remaining.indexOf(name);
    return i >= 0 ? remaining.splice(i, 1)[0] : undefined;
  };

  for (const slot of slots) {
    const spec = mapping[slot];
    if (spec) {
      if (!photos.includes(spec.src)) {
        throw new Error(`mapping.json: ${slot} の src「${spec.src}」が assets/photos/ にありません`);
      }
      take(spec.src);
      out.set(slot, spec);
    }
  }
  for (const slot of slots) {
    if (out.has(slot)) continue;
    const stem = remaining.find((f) => path.parse(f).name === slot);
    if (stem) out.set(slot, { src: take(stem)! });
  }
  for (const slot of slots) {
    if (out.has(slot)) continue;
    const next = remaining.shift();
    if (next) out.set(slot, { src: next });
  }
  return out;
}

/**
 * focal を残しつつ target の比率へ cover トリミングする矩形を返す。
 * focal は切り出し窓の中心に置きたい点。窓が画像の外へ出る場合は端に寄せる。
 */
function coverRect(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  focal: Focal,
  zoom: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const targetAspect = targetW / targetH;
  const srcAspect = srcW / srcH;

  // まず比率を合わせた最大の窓を取り、zoom ぶん縮める（= 寄る）
  let sw = srcAspect > targetAspect ? srcH * targetAspect : srcW;
  let sh = srcAspect > targetAspect ? srcH : srcW / targetAspect;
  sw /= zoom;
  sh /= zoom;

  const cx = focal.x * srcW;
  const cy = focal.y * srcH;
  const sx = Math.min(Math.max(cx - sw / 2, 0), srcW - sw);
  const sy = Math.min(Math.max(cy - sh / 2, 0), srcH - sh);

  return { sx, sy, sw, sh };
}

/**
 * ffmpeg で切り出して拡縮する。canvas の drawImage よりも lanczos のほうが
 * 拡大時のディテールが残る。さらに拡大方向のときは軽く unsharp をかける。
 * 拡大率に応じて強度を上げるが、輪郭が立ちすぎると安っぽくなるので上限を置く。
 */
async function cropResize(
  src: string,
  dest: string,
  rect: { sx: number; sy: number; sw: number; sh: number },
  target: { width: number; height: number },
  quality: number,
): Promise<void> {
  if (!ffmpegPath) throw new Error('ffmpeg-static が見つかりません');

  const upscale = target.width / rect.sw;
  const filters = [
    `crop=${Math.round(rect.sw)}:${Math.round(rect.sh)}:${Math.round(rect.sx)}:${Math.round(rect.sy)}`,
    `scale=${target.width}:${target.height}:flags=lanczos`,
  ];
  if (upscale > 1.2) {
    const amount = Math.min(0.9, 0.35 * upscale);
    filters.push(`unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${amount.toFixed(2)}`);
  }

  // JPEG の品質は 2（最高）〜31（最低）。--quality の 0-100 から写す
  const qscale = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));

  await run(ffmpegPath, [
    '-y',
    '-loglevel',
    'error',
    '-i',
    src,
    '-vf',
    filters.join(','),
    '-q:v',
    String(qscale),
    dest,
  ]);
}

async function main(): Promise<void> {
  const { project, quality } = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(project);
  const photosDir = path.join(projectDir, 'assets', 'photos');

  if (!existsSync(photosDir)) {
    console.error(`assets/photos/ がありません: ${photosDir}`);
    process.exit(1);
  }

  const photos = (await readdir(photosDir))
    .filter((f) => PHOTO_EXT.has(path.extname(f).toLowerCase()))
    .sort();

  if (photos.length === 0) {
    console.error(
      `assets/photos/ に写真がありません。${[...PHOTO_EXT].join(' / ')} のいずれかを置いてください。`,
    );
    process.exit(1);
  }

  const mapping = await readMapping(photosDir);
  const assigned = assign(SLOTS, photos, mapping);

  const missing = SLOTS.filter((s) => !assigned.has(s));
  if (missing.length > 0) {
    console.error(
      `写真が ${photos.length} 枚しかないため、次のスロットを埋められません: ${missing.join(', ')}\n` +
        `${SLOTS.length} 枚必要です（引き / 引き / 中景 / 寄り / クローズ）。`,
    );
    process.exit(1);
  }

  console.log(`写真 ${photos.length} 枚 → スロット ${SLOTS.length}`);

  const warnings: string[] = [];

  for (const target of TARGETS) {
    const outDir = path.join(projectDir, 'assets', target.ratio);
    await mkdir(outDir, { recursive: true });

    for (const slot of SLOTS) {
      const spec = assigned.get(slot)!;
      const focal = spec.focal ?? { x: 0.5, y: 0.45 };
      const zoom = spec.zoom ?? 1;
      const image = await loadImage(path.join(photosDir, spec.src));

      const { sx, sy, sw, sh } = coverRect(
        image.width,
        image.height,
        target.width,
        target.height,
        focal,
        zoom,
      );

      // 拡大方向になる素材は、動画側の zoompan でさらに寄るため粗が出やすい
      if (sw < target.width) {
        warnings.push(
          `${target.ratio}/${slot}: 元画像が小さく ${Math.round((target.width / sw) * 100)}% に拡大しています（${spec.src}）`,
        );
      }

      const file = path.join(outDir, `${slot}.jpg`);
      await cropResize(path.join(photosDir, spec.src), file, { sx, sy, sw, sh }, target, quality);
      console.log(`  ${target.ratio}  ${slot}.jpg  ← ${spec.src}`);
    }
  }

  if (warnings.length > 0) {
    console.log('\n注意:');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  console.log(
    '\n完了。次はこの順で確認する:\n' +
      `  npx tsx src/cli.ts layout --project ${project} --template editorial-5cut --strategy orthogonal:5\n` +
      `  npx tsx src/cli.ts render --project ${project} --template editorial-5cut --strategy orthogonal:5`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
