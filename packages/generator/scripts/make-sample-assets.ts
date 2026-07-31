/**
 * デモ用のダミー素材を作る。
 * 実案件では撮影素材やストックフォトをここに置き換えるだけでよく、
 * project.json の assets[].file が指す先が差し替わればテンプレートは触らなくていい。
 *
 *   npm run sample-assets
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { FFMPEG_BIN, runFfmpeg } from '../src/ffmpeg.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(HERE, '../projects/sample-2weeksale/assets');

const WIDTH = 1800;
const HEIGHT = 2250;

interface Look {
  file: string;
  label: string;
  from: string;
  to: string;
  accent: string;
  shape: 'circles' | 'stripes' | 'waves' | 'blocks';
}

const LOOKS: Look[] = [
  { file: 'hero1.jpg', label: 'SAMPLE 01 / 夜行列車の車窓', from: '#0A1B3D', to: '#2B4C8C', accent: '#FFD400', shape: 'circles' },
  { file: 'hero2.jpg', label: 'SAMPLE 02 / 海沿いの路線', from: '#04475E', to: '#0FA3A3', accent: '#FFFFFF', shape: 'waves' },
  { file: 'hero3.jpg', label: 'SAMPLE 03 / 山間の紅葉', from: '#5C2408', to: '#C4661B', accent: '#FFE9A8', shape: 'stripes' },
  { file: 'hero4.jpg', label: 'SAMPLE 04 / 駅ホームの朝', from: '#1C2233', to: '#6E7A99', accent: '#FFD400', shape: 'blocks' },
];

function registerFont(): string {
  const candidates = [
    '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf',
    '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf',
    '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
    'C:\\Windows\\Fonts\\YuGothB.ttc',
  ];
  for (const candidate of candidates) {
    if (GlobalFonts.registerFromPath(candidate, 'sample-jp')) return 'sample-jp';
  }
  return 'sans-serif';
}

async function makeImage(look: Look, family: string): Promise<void> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, WIDTH * 0.4, HEIGHT);
  bg.addColorStop(0, look.from);
  bg.addColorStop(1, look.to);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = look.accent;
  ctx.strokeStyle = look.accent;

  switch (look.shape) {
    case 'circles':
      for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.arc(WIDTH * (0.2 + 0.1 * i), HEIGHT * (0.25 + 0.08 * (i % 4)), 90 + i * 46, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'stripes':
      ctx.lineWidth = 46;
      for (let i = -6; i < 22; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 150, 0);
        ctx.lineTo(i * 150 + HEIGHT * 0.55, HEIGHT);
        ctx.stroke();
      }
      break;
    case 'waves':
      ctx.lineWidth = 26;
      for (let row = 0; row < 12; row++) {
        const y = HEIGHT * (0.18 + row * 0.065);
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= WIDTH; x += 24) {
          ctx.lineTo(x, y + Math.sin((x / WIDTH) * Math.PI * 4 + row) * 44);
        }
        ctx.stroke();
      }
      break;
    case 'blocks':
      for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 7; col++) {
          if ((row + col) % 3 !== 0) continue;
          ctx.fillRect(col * 260 + 40, row * 250 + 60, 200, 190);
        }
      }
      break;
  }
  ctx.restore();

  // 上下のビネット。実写素材に近い明暗を作ってテロップの見え方を確認しやすくする
  const vignette = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  vignette.addColorStop(0, 'rgba(0,0,0,0.34)');
  vignette.addColorStop(0.45, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 中央にラベル。どのカットが使われたか目視で追える
  ctx.font = `600 62px "${family}"`;
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(look.label, WIDTH / 2, HEIGHT / 2);

  ctx.font = `400 34px "${family}"`;
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText('ダミー素材 — 実素材に差し替えてください', WIDTH / 2, HEIGHT / 2 + 78);

  await writeFile(path.join(ASSET_DIR, look.file), canvas.toBuffer('image/jpeg', 82));
}

async function makeLogo(family: string): Promise<void> {
  const w = 900;
  const h = 260;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(h / 2, h / 2, h / 2 - 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#0B5FA5';
  ctx.font = `700 96px "${family}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('S', h / 2, h / 2 + 4);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 82px "${family}"`;
  ctx.textAlign = 'left';
  ctx.fillText('サンプル鉄道', h + 24, h / 2 + 4);

  await writeFile(path.join(ASSET_DIR, 'logo.png'), canvas.toBuffer('image/png'));
}

/** 権利フリーの仮BGM。ゆるいコードのパッドを合成する */
async function makeBgm(): Promise<void> {
  const out = path.join(ASSET_DIR, 'bgm.mp3');
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=24',
    '-f', 'lavfi', '-i', 'sine=frequency=277.18:duration=24',
    '-f', 'lavfi', '-i', 'sine=frequency=329.63:duration=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24',
    '-filter_complex',
    '[0][1][2][3]amix=inputs=4:duration=longest,lowpass=f=1200,tremolo=f=0.45:d=0.35,volume=0.6,afade=t=in:st=0:d=1.5,afade=t=out:st=22:d=2[a]',
    '-map', '[a]',
    '-c:a', 'libmp3lame', '-b:a', '96k', '-ac', '2', '-ar', '48000',
    out,
  ]);
}

async function main(): Promise<void> {
  await mkdir(ASSET_DIR, { recursive: true });
  const family = registerFont();

  for (const look of LOOKS) await makeImage(look, family);
  await makeLogo(family);

  try {
    await makeBgm();
  } catch (error) {
    console.warn(`[bgm] 生成に失敗したので無音で進めます (${FFMPEG_BIN}): ${(error as Error).message.split('\n')[0]}`);
  }

  console.log(`サンプル素材を生成しました: ${ASSET_DIR}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
