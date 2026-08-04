/**
 * 京都紅葉旅の案件用のダミー素材を手続き的に描く。
 *
 * 実写素材が用意できるまでの代替。実写に差し替えるときは
 * projects/kyoto-koyo/assets/ のファイルを置き換えるだけで、
 * テンプレートも project.json も触らずに済む。
 *
 *   npm run kyoto-assets
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { runFfmpeg } from '../src/ffmpeg.js';
import { writeBgmMp3 } from './make-bgm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(HERE, '../projects/kyoto-koyo/assets');

/**
 * 出力サイズは面ごとに変える。
 *
 * 1枚の縦長素材を 16:9 に切ると上下が半分以上落ちて、参道の奥行きや
 * 塔の全景といった「構図そのもの」が失われる。組版は面ごとに解決し直せても、
 * 素材の構図は切り抜きでは作れない。手続き生成なら描き直せるので、
 * 面ごとに専用の素材を出す。
 * （実写の場合も、16:9 で撮って縦を切り出すより面ごとに抑えるのが本来の形）
 */
const TARGETS = [
  { ratio: '16x9', width: 2400, height: 1350 },
  { ratio: '9x16', width: 1560, height: 2772 },
] as const;

// 各シーン関数から参照する現在のキャンバス寸法
let W: number = TARGETS[0].width;
let H: number = TARGETS[0].height;

/* ------------------------------------------------------------------ *
 * 乱数（毎回同じ絵が出るように固定シード）
 * ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * 描画パーツ
 * ------------------------------------------------------------------ */

function verticalGradient(ctx: SKRSContext2D, stops: [number, string][], top = 0, bottom = H): void {
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, top, W, bottom - top);
}

/** 紅葉の葉。小さく大量に置くので5裂のシルエットで十分読める */
function mapleLeaf(ctx: SKRSContext2D, cx: number, cy: number, size: number, rot: number, color: string): void {
  // 中心から上向き(0°)を先端として、右半分の輪郭を「裂片の先」と「切れ込み」で刻む
  const right: [number, number][] = [
    [0, 1.0],
    [22, 0.4],
    [45, 0.82],
    [68, 0.34],
    [92, 0.6],
    [115, 0.24],
    [150, 0.18],
  ];

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(size, size);
  ctx.beginPath();

  const toXY = (deg: number, r: number, mirror: boolean): [number, number] => {
    const rad = ((mirror ? -deg : deg) * Math.PI) / 180;
    return [Math.sin(rad) * r, -Math.cos(rad) * r];
  };

  const [sx, sy] = toXY(right[0]![0], right[0]![1], false);
  ctx.moveTo(sx, sy);
  for (const [deg, r] of right.slice(1)) {
    const [x, y] = toXY(deg, r, false);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(0.04, 0.34); // 葉柄の付け根
  ctx.lineTo(0.03, 0.62); // 葉柄
  ctx.lineTo(-0.03, 0.62);
  ctx.lineTo(-0.04, 0.34);
  for (const [deg, r] of [...right].reverse().slice(0, -1)) {
    const [x, y] = toXY(deg, r, true);
    ctx.lineTo(x, y);
  }
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

const AUTUMN = ['#B3231F', '#D14A22', '#E0752A', '#EFA134', '#C0392B', '#8E1B18', '#F0BB4E'];

/** 画面上部から垂れ下がる紅葉の天蓋 */
function canopy(
  ctx: SKRSContext2D,
  rand: () => number,
  opts: { count: number; maxY: number; sizeMin: number; sizeMax: number; alpha?: number },
): void {
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  for (let i = 0; i < opts.count; i++) {
    const x = rand() * W;
    // 上に寄せる分布（y^1.7）
    const y = Math.pow(rand(), 1.7) * opts.maxY;
    const size = opts.sizeMin + rand() * (opts.sizeMax - opts.sizeMin);
    const color = AUTUMN[Math.floor(rand() * AUTUMN.length)]!;
    ctx.globalAlpha = (opts.alpha ?? 1) * (0.55 + rand() * 0.45);
    mapleLeaf(ctx, x, y, size, (rand() - 0.5) * Math.PI * 2, color);
  }
  ctx.restore();
}

/** 山の稜線。layers を重ねると空気遠近になる */
function ridge(
  ctx: SKRSContext2D,
  rand: () => number,
  baseY: number,
  amp: number,
  color: string,
): void {
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, baseY);
  const seg = 12;
  let prev = baseY;
  for (let i = 1; i <= seg; i++) {
    const x = (W / seg) * i;
    const y = baseY + (rand() - 0.5) * amp;
    ctx.quadraticCurveTo(x - W / seg / 2, prev, x, y);
    prev = y;
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** 五重塔のシルエット */
function pagoda(ctx: SKRSContext2D, cx: number, baseY: number, height: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  const tiers = 5;
  const tierH = height / (tiers + 1.2);

  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const roofW = (height * 0.62) * (1 - t * 0.42);
    const y = baseY - tierH * (i + 1);

    // 反りのある屋根
    ctx.beginPath();
    ctx.moveTo(cx - roofW / 2, y);
    ctx.quadraticCurveTo(cx - roofW * 0.28, y - tierH * 0.34, cx, y - tierH * 0.42);
    ctx.quadraticCurveTo(cx + roofW * 0.28, y - tierH * 0.34, cx + roofW / 2, y);
    ctx.quadraticCurveTo(cx + roofW * 0.34, y + tierH * 0.1, cx, y + tierH * 0.06);
    ctx.quadraticCurveTo(cx - roofW * 0.34, y + tierH * 0.1, cx - roofW / 2, y);
    ctx.closePath();
    ctx.fill();

    // 胴部
    const bodyW = roofW * 0.5;
    ctx.fillRect(cx - bodyW / 2, y, bodyW, tierH * 0.95);
  }

  // 相輪
  ctx.fillRect(cx - height * 0.012, baseY - height * 1.06, height * 0.024, height * 0.16);
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(cx, baseY - height * (1.0 + i * 0.028), height * 0.026 - i * 0.003, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 提灯。灯りのにじみも一緒に描く */
function lantern(ctx: SKRSContext2D, x: number, y: number, r: number, glow: string): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
  g.addColorStop(0, glow);
  g.addColorStop(0.25, 'rgba(255,190,110,0.28)');
  g.addColorStop(1, 'rgba(255,180,100,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 7, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#FFE0A8';
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.72, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(120,40,30,0.55)';
  ctx.fillRect(x - r * 0.72, y - r * 0.08, r * 1.44, r * 0.16);
}

/** フィルムグレイン。イラストでも写真に近い密度感が出る */
function grain(ctx: SKRSContext2D, rand: () => number, amount = 42000): void {
  ctx.save();
  for (let i = 0; i < amount; i++) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.045)';
    ctx.fillRect(rand() * W, rand() * H, 2, 2);
  }
  ctx.restore();
}

// カット間のトーン統一は素材側でやらず、テンプレートの scenes[].grade
// （ffmpeg の eq フィルタ）で行う。素材は素のまま置いておくほうが、
// 実写に差し替えたときに同じ調整がそのまま効く。

/** 上下のビネット。テロップの見え方を実素材に近づける */
function vignette(ctx: SKRSContext2D, topStrength = 0.3, bottomStrength = 0.34): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `rgba(0,0,0,${topStrength})`);
  g.addColorStop(0.42, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${bottomStrength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/* ------------------------------------------------------------------ *
 * 4カットぶんの情景
 * ------------------------------------------------------------------ */

/** 01 紅葉の参道。奥行きのあるトンネル */
function sceneApproach(ctx: SKRSContext2D): void {
  const rand = mulberry32(1101);

  verticalGradient(ctx, [
    [0, '#7E1B18'],
    [0.34, '#C0492A'],
    [0.62, '#E89545'],
    [1, '#F6D69B'],
  ]);

  // 奥に抜ける光。中央ではなく左三分割に置き、右側を縦書きが乗る余白にする
  const vanishX = W * 0.38;
  const glow = ctx.createRadialGradient(vanishX, H * 0.62, 0, vanishX, H * 0.62, W * 0.5);
  glow.addColorStop(0, 'rgba(255,240,200,0.92)');
  glow.addColorStop(0.35, 'rgba(255,220,160,0.35)');
  glow.addColorStop(1, 'rgba(255,210,150,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // 参道（透視）。奥ほど日が当たって明るく、手前は影に落とす。
  // 逆にすると三角形が山のシルエットに見えてしまう
  const pathTopY = H * 0.6;
  const road = ctx.createLinearGradient(0, pathTopY, 0, H);
  road.addColorStop(0, 'rgba(255,236,196,0.92)');
  road.addColorStop(0.3, 'rgba(226,186,140,0.85)');
  road.addColorStop(1, 'rgba(126,84,62,0.9)');
  ctx.fillStyle = road;
  const roadPath = () => {
    ctx.beginPath();
    ctx.moveTo(vanishX - 60, pathTopY);
    ctx.lineTo(vanishX + 60, pathTopY);
    ctx.lineTo(W * 1.02, H);
    ctx.lineTo(-W * 0.3, H);
    ctx.closePath();
  };
  roadPath();
  ctx.fill();

  // 石畳の横目。奥ほど間隔を詰めて距離感を出す
  ctx.save();
  roadPath();
  ctx.clip();
  for (let i = 0; i < 18; i++) {
    const t = i / 17;
    const y = pathTopY + Math.pow(t, 1.9) * (H - pathTopY);
    ctx.strokeStyle = `rgba(92,58,42,${0.1 + t * 0.22})`;
    ctx.lineWidth = 2 + t * 7;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();

  // 並木。手前ほど太く暗く、幹は少し傾ける
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const depth = Math.pow(t, 1.5);
      const x = vanishX + side * (100 + depth * W * 0.6);
      const topY = H * 0.58 - depth * H * 0.5;
      const width = 30 + depth * 150;
      const lean = side * depth * 46;
      ctx.fillStyle = `rgba(52,28,24,${0.62 + depth * 0.34})`;
      ctx.beginPath();
      ctx.moveTo(x - width / 2, H);
      ctx.lineTo(x - width * 0.3 + lean, topY);
      ctx.lineTo(x + width * 0.3 + lean, topY);
      ctx.lineTo(x + width / 2, H);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 天蓋
  canopy(ctx, rand, { count: 620, maxY: H * 0.66, sizeMin: 22, sizeMax: 86 });
  // 手前の大きな葉（被写界深度の代わり）
  canopy(ctx, rand, { count: 46, maxY: H * 0.3, sizeMin: 110, sizeMax: 220, alpha: 0.85 });

  // 散り葉
  for (let i = 0; i < 130; i++) {
    const y = H * 0.72 + Math.pow(rand(), 0.6) * H * 0.28;
    mapleLeaf(ctx, rand() * W, y, 20 + rand() * 46, (rand() - 0.5) * 3, AUTUMN[Math.floor(rand() * AUTUMN.length)]!);
  }

  // 右側を落として縦書きの背景を作る
  const rightShade = ctx.createLinearGradient(W * 0.42, 0, W, 0);
  rightShade.addColorStop(0, 'rgba(20,10,8,0)');
  rightShade.addColorStop(1, 'rgba(20,10,8,0.5)');
  ctx.fillStyle = rightShade;
  ctx.fillRect(0, 0, W, H);

  vignette(ctx, 0.24, 0.4);
  grain(ctx, rand);
}

/** 02 五重塔と夕景 */
function scenePagoda(ctx: SKRSContext2D): void {
  const rand = mulberry32(2202);

  verticalGradient(ctx, [
    [0, '#2B1A3C'],
    [0.28, '#6B2C46'],
    [0.5, '#B4533F'],
    [0.68, '#E38A46'],
    [0.82, '#F6C173'],
    [1, '#8A4A33'],
  ]);

  // 太陽
  const sunY = H * 0.66;
  const sun = ctx.createRadialGradient(W * 0.3, sunY, 0, W * 0.3, sunY, 420);
  sun.addColorStop(0, 'rgba(255,246,214,0.98)');
  sun.addColorStop(0.18, 'rgba(255,220,150,0.7)');
  sun.addColorStop(1, 'rgba(255,200,130,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, W, H);

  // 山（3層）
  ridge(ctx, mulberry32(31), H * 0.7, 150, 'rgba(120,74,66,0.5)');
  ridge(ctx, mulberry32(32), H * 0.76, 120, 'rgba(86,50,50,0.62)');
  ridge(ctx, mulberry32(33), H * 0.83, 90, 'rgba(54,32,36,0.78)');

  // 塔
  pagoda(ctx, W * 0.66, H * 0.86, H * 0.44, 'rgba(30,20,24,0.94)');

  // 町並みのシルエット
  ctx.fillStyle = 'rgba(34,22,26,0.9)';
  for (let x = 0; x < W; x += 96) {
    const h = 60 + ((x * 37) % 130);
    ctx.fillRect(x, H * 0.86 - h, 92, h + 40);
  }
  ctx.fillRect(0, H * 0.86, W, H * 0.14);

  // 手前の枝と葉
  canopy(ctx, rand, { count: 240, maxY: H * 0.34, sizeMin: 40, sizeMax: 150, alpha: 0.95 });
  ctx.strokeStyle = 'rgba(28,18,20,0.85)';
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.moveTo(-40, H * 0.06);
  ctx.quadraticCurveTo(W * 0.34, H * 0.2, W * 0.78, H * 0.05);
  ctx.stroke();

  vignette(ctx, 0.16, 0.34);
  grain(ctx, rand);
}

/** 03 渓谷と川。朝霧の嵐山を想定 */
function sceneRiver(ctx: SKRSContext2D): void {
  const rand = mulberry32(3303);

  verticalGradient(ctx, [
    [0, '#C9DCE6'],
    [0.3, '#E7DCCC'],
    [0.52, '#F2D9B4'],
    [1, '#9BA8A6'],
  ]);

  // 山（奥から手前へ、紅葉の色を混ぜる）
  ridge(ctx, mulberry32(41), H * 0.38, 190, 'rgba(158,166,170,0.5)');
  ridge(ctx, mulberry32(42), H * 0.46, 160, 'rgba(176,124,88,0.66)');
  ridge(ctx, mulberry32(43), H * 0.53, 140, 'rgba(160,80,46,0.8)');

  // 斜面の紅葉。y を稜線に沿ってうねらせ、帯にならないようにする
  ctx.save();
  for (let i = 0; i < 1100; i++) {
    const x = rand() * W;
    const wave = Math.sin((x / W) * Math.PI * 2.6) * H * 0.03;
    const y = H * 0.43 + wave + Math.pow(rand(), 0.7) * H * 0.19;
    ctx.globalAlpha = 0.5 + rand() * 0.5;
    mapleLeaf(ctx, x, y, 14 + rand() * 44, rand() * 6, AUTUMN[Math.floor(rand() * AUTUMN.length)]!);
  }
  ctx.restore();

  // 川面
  const waterTop = H * 0.618;
  const water = ctx.createLinearGradient(0, waterTop, 0, H);
  water.addColorStop(0, '#8B9A9A');
  water.addColorStop(0.4, '#5E7276');
  water.addColorStop(1, '#3A4C50');
  ctx.fillStyle = water;
  ctx.fillRect(0, waterTop, W, H - waterTop);

  // 水面の反射
  ctx.save();
  for (let i = 0; i < 150; i++) {
    const y = waterTop + 8 + rand() * (H - waterTop - 20);
    const len = 60 + rand() * 420;
    ctx.globalAlpha = 0.05 + rand() * 0.16;
    ctx.fillStyle = rand() > 0.45 ? '#E9C99B' : '#C9573A';
    ctx.fillRect(rand() * W, y, len, 3 + rand() * 7);
  }
  ctx.restore();

  // 渡月橋を想定した橋。桁は水面より上、橋脚だけを水に下ろす
  const deckEdgeY = H * 0.625;
  const deckMidY = H * 0.588;
  const archAt = (x: number): number => deckEdgeY - Math.sin((x / W) * Math.PI) * (deckEdgeY - deckMidY);

  // 橋脚（先に描いて桁の下に隠す）
  ctx.fillStyle = 'rgba(58,42,36,0.92)';
  for (let x = 130; x < W; x += 230) {
    ctx.fillRect(x - 11, archAt(x), 22, H * 0.085);
  }

  // 桁
  ctx.fillStyle = 'rgba(74,54,44,0.95)';
  ctx.beginPath();
  ctx.moveTo(-20, deckEdgeY);
  ctx.quadraticCurveTo(W * 0.5, deckMidY - 12, W + 20, deckEdgeY);
  ctx.lineTo(W + 20, deckEdgeY + H * 0.019);
  ctx.quadraticCurveTo(W * 0.5, deckMidY + H * 0.007, -20, deckEdgeY + H * 0.019);
  ctx.closePath();
  ctx.fill();

  // 欄干
  ctx.fillStyle = 'rgba(92,66,52,0.9)';
  ctx.beginPath();
  ctx.moveTo(-20, deckEdgeY - H * 0.026);
  ctx.quadraticCurveTo(W * 0.5, deckMidY - H * 0.032, W + 20, deckEdgeY - H * 0.026);
  ctx.lineTo(W + 20, deckEdgeY - H * 0.017);
  ctx.quadraticCurveTo(W * 0.5, deckMidY - H * 0.023, -20, deckEdgeY - H * 0.017);
  ctx.closePath();
  ctx.fill();
  for (let x = 44; x < W; x += 76) {
    ctx.fillRect(x, archAt(x) - H * 0.024, 9, H * 0.022);
  }

  // 朝霧
  for (let i = 0; i < 5; i++) {
    const y = H * (0.42 + i * 0.055);
    const g = ctx.createLinearGradient(0, y - 60, 0, y + 60);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,252,246,${0.3 - i * 0.045})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 60, W, 120);
  }

  canopy(ctx, rand, { count: 130, maxY: H * 0.2, sizeMin: 70, sizeMax: 190, alpha: 0.9 });

  vignette(ctx, 0.2, 0.3);
  grain(ctx, rand);
}

/** 04 石畳の路地。夜の提灯 */
function sceneAlley(ctx: SKRSContext2D): void {
  const rand = mulberry32(4404);

  verticalGradient(ctx, [
    [0, '#171220'],
    [0.38, '#291D27'],
    [0.66, '#3A2A2C'],
    [1, '#241B20'],
  ]);

  // 奥の抜け
  const far = ctx.createRadialGradient(W * 0.5, H * 0.56, 0, W * 0.5, H * 0.56, W * 0.42);
  far.addColorStop(0, 'rgba(255,196,120,0.22)');
  far.addColorStop(1, 'rgba(255,180,110,0)');
  ctx.fillStyle = far;
  ctx.fillRect(0, 0, W, H);

  // 町家（両側・透視）
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const depth = Math.pow(t, 1.4);
      const inner = W * 0.5 + side * (110 + depth * W * 0.56);
      const outer = inner + side * (200 + depth * 420);
      const topY = H * 0.52 - depth * H * 0.44;

      ctx.fillStyle = `rgba(26,18,20,${0.72 + depth * 0.26})`;
      ctx.beginPath();
      ctx.moveTo(inner, H);
      ctx.lineTo(inner, topY);
      ctx.lineTo(outer, topY - depth * 120);
      ctx.lineTo(outer, H);
      ctx.closePath();
      ctx.fill();

      // 格子窓の灯り
      const winY = topY + (H - topY) * 0.3;
      const winH = 40 + depth * 150;
      const winW = 60 + depth * 190;
      const winX = inner + side * (36 + depth * 130);
      const g = ctx.createLinearGradient(0, winY, 0, winY + winH);
      g.addColorStop(0, 'rgba(255,206,132,0.9)');
      g.addColorStop(1, 'rgba(226,150,74,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(Math.min(winX, winX + side * winW), winY, winW, winH);
    }
  }

  // 石畳
  ctx.fillStyle = 'rgba(44,34,36,0.95)';
  ctx.beginPath();
  ctx.moveTo(W * 0.5 - 100, H * 0.52);
  ctx.lineTo(W * 0.5 + 100, H * 0.52);
  ctx.lineTo(W * 1.2, H);
  ctx.lineTo(-W * 0.2, H);
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const y = H * 0.53 + Math.pow(t, 1.7) * H * 0.47;
    const spread = 100 + Math.pow(t, 1.7) * W * 0.7;
    ctx.strokeStyle = `rgba(120,96,84,${0.1 + t * 0.2})`;
    ctx.lineWidth = 2 + t * 6;
    ctx.beginPath();
    ctx.moveTo(W * 0.5 - spread, y);
    ctx.lineTo(W * 0.5 + spread, y);
    ctx.stroke();
  }
  // 濡れた路面の照り返し
  for (let i = 0; i < 60; i++) {
    const t = rand();
    const y = H * 0.56 + Math.pow(t, 1.5) * H * 0.44;
    ctx.fillStyle = `rgba(255,190,120,${0.03 + rand() * 0.1})`;
    ctx.fillRect(W * 0.5 - (60 + t * W * 0.5) * rand(), y, 30 + rand() * 260, 4 + t * 10);
  }

  // 提灯
  const lanterns: [number, number, number][] = [
    [W * 0.34, H * 0.44, 26],
    [W * 0.66, H * 0.42, 24],
    [W * 0.22, H * 0.34, 40],
    [W * 0.79, H * 0.31, 44],
    [W * 0.5, H * 0.5, 18],
  ];
  for (const [x, y, r] of lanterns) lantern(ctx, x, y, r, 'rgba(255,214,150,0.95)');

  canopy(ctx, rand, { count: 200, maxY: H * 0.26, sizeMin: 44, sizeMax: 150, alpha: 0.78 });

  vignette(ctx, 0.4, 0.42);
  grain(ctx, rand, 52000);
}

/** 05 丸窓から見る紅葉。室内の寄りカット */
function sceneRoundWindow(ctx: SKRSContext2D): void {
  const rand = mulberry32(5505);

  // 室内。全体を暗く落として、窓の中だけが光る 状態 を作る
  verticalGradient(ctx, [
    [0, '#171210'],
    [0.5, '#211A15'],
    [0.66, '#2A211A'],
    [1, '#3A2F24'],
  ]);

  const tatamiTop = H * 0.66;
  // 窓を右三分割に置き、左半分を無地の壁にしてテロップの居場所を作る。
  // 障子の格子の上に文字を乗せると背景が忙しく、読めなくなる。
  const cx = W * (W > H ? 0.63 : 0.54);
  // 円の下端が畳より上に収まるよう、中心と半径を面ごとに決める
  const cy = H * (W > H ? 0.33 : 0.29);
  const radius = Math.min(W, H) * (W > H ? 0.32 : 0.3);

  // 柱を一本。無地の壁だけだと平坦なので、構造の手がかりを置く
  ctx.fillStyle = 'rgba(14,10,8,0.55)';
  ctx.fillRect(W * (W > H ? 0.2 : 0.13), 0, Math.max(6, W * 0.012), tatamiTop);

  // 窓の中の紅葉。円でクリップしてから描く
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  const sky = ctx.createLinearGradient(0, cy - radius, 0, cy + radius);
  sky.addColorStop(0, '#C9762A');
  sky.addColorStop(0.45, '#E0983C');
  sky.addColorStop(1, '#6E4A22');
  ctx.fillStyle = sky;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

  // 幹を数本入れて庭の奥行きを作る
  ctx.fillStyle = 'rgba(58,34,24,0.7)';
  for (let i = 0; i < 4; i++) {
    const x = cx - radius + radius * 0.5 * i + rand() * radius * 0.2;
    ctx.fillRect(x, cy - radius, radius * 0.06, radius * 2);
  }

  for (let i = 0; i < 420; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand()) * radius;
    ctx.globalAlpha = 0.55 + rand() * 0.45;
    mapleLeaf(
      ctx,
      cx + Math.cos(angle) * dist,
      cy + Math.sin(angle) * dist,
      radius * (0.05 + rand() * 0.09),
      rand() * 6,
      AUTUMN[Math.floor(rand() * AUTUMN.length)]!,
    );
  }
  ctx.restore();

  // 窓枠
  ctx.strokeStyle = '#100B09';
  ctx.lineWidth = Math.max(6, radius * 0.075);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  // 畳。目の細かい横線と縁
  ctx.fillStyle = '#4A3B2B';
  ctx.fillRect(0, tatamiTop, W, H - tatamiTop);
  ctx.strokeStyle = 'rgba(24,18,14,0.35)';
  ctx.lineWidth = 1;
  for (let y = tatamiTop; y < H; y += Math.max(4, H * 0.006)) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(18,13,10,0.8)';
  ctx.lineWidth = Math.max(3, W * 0.004);
  ctx.beginPath();
  ctx.moveTo(0, tatamiTop);
  ctx.lineTo(W, tatamiTop);
  ctx.stroke();

  // 窓から畳に落ちる光
  const spill = ctx.createRadialGradient(cx, tatamiTop + (H - tatamiTop) * 0.35, 0, cx, tatamiTop + (H - tatamiTop) * 0.35, radius * 1.5);
  spill.addColorStop(0, 'rgba(232,168,92,0.24)');
  spill.addColorStop(1, 'rgba(232,168,92,0)');
  ctx.fillStyle = spill;
  ctx.fillRect(0, tatamiTop, W, H - tatamiTop);

  vignette(ctx, 0.46, 0.3);
  grain(ctx, rand, 46000);
}

/* ------------------------------------------------------------------ *
 * ロゴ / BGM
 * ------------------------------------------------------------------ */

function registerFont(): string {
  const candidates = [
    '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf',
    '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf',
    '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
    'C:\\Windows\\Fonts\\YuGothB.ttc',
  ];
  for (const candidate of candidates) {
    if (GlobalFonts.registerFromPath(candidate, 'kyoto-jp')) return 'kyoto-jp';
  }
  return 'sans-serif';
}

async function makeLogo(family: string): Promise<void> {
  const w = 1000;
  const h = 250;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  mapleLeaf(ctx, 118, h / 2, 96, 0.12, '#FFFFFF');

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 92px "${family}"`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('京あかり旅', 226, h / 2 - 4);

  ctx.font = `400 34px "${family}"`;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillText('KYO-AKARI TRAVEL', 230, h / 2 + 66);

  await writeFile(path.join(ASSET_DIR, 'logo.png'), canvas.toBuffer('image/png'));
}

/** 和風の五音音階を想定した仮BGM */
async function makeBgm(): Promise<void> {
  await writeBgmMp3(path.join(ASSET_DIR, 'bgm.mp3'));
}

/* ------------------------------------------------------------------ */

const SCENES: Array<{ file: string; draw: (ctx: SKRSContext2D) => void }> = [
  { file: 'koyo-approach.jpg', draw: sceneApproach },
  { file: 'koyo-pagoda.jpg', draw: scenePagoda },
  { file: 'koyo-river.jpg', draw: sceneRiver },
  { file: 'koyo-alley.jpg', draw: sceneAlley },
  { file: 'koyo-window.jpg', draw: sceneRoundWindow },
];

async function main(): Promise<void> {
  const family = registerFont();

  for (const target of TARGETS) {
    W = target.width;
    H = target.height;
    const dir = path.join(ASSET_DIR, target.ratio);
    await mkdir(dir, { recursive: true });

    for (const scene of SCENES) {
      const canvas = createCanvas(W, H);
      scene.draw(canvas.getContext('2d'));
      await writeFile(path.join(dir, scene.file), canvas.toBuffer('image/jpeg', 86));
    }
    console.log(`  ${target.ratio}  ${W}x${H}  ${SCENES.length} カット`);
  }

  // ロゴは面に依存しないので共通で1枚
  await mkdir(ASSET_DIR, { recursive: true });
  await makeLogo(family);
  try {
    await makeBgm();
  } catch (error) {
    console.warn(`[bgm] 生成に失敗したので無音で進めます: ${(error as Error).message.split('\n')[0]}`);
  }

  console.log(`素材を生成しました: ${ASSET_DIR}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
