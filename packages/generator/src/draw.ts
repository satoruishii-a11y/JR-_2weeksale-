import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import type {
  Anchor,
  BandOverlay,
  ImageOverlay,
  Overlay,
  Project,
  RenderTarget,
  ScrimOverlay,
  TextOverlay,
  TextStyle,
} from './types.js';

/**
 * オーバーレイを透過 PNG に焼いてから ffmpeg で合成する。
 * ffmpeg の drawtext を使わない理由は 3 つ:
 *   - 日本語の折り返し・禁則・字間を自前で制御できる
 *   - 帯 / 縁取り / 影を組み合わせたレイヤーを 1 枚に畳める（合成回数が減る）
 *   - drawtext 非搭載の ffmpeg ビルドでも動く
 */

const BUILTIN_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf',
  '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf',
  '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJKjp-Bold.otf',
  '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  'C:\\Windows\\Fonts\\meiryob.ttc',
  'C:\\Windows\\Fonts\\YuGothB.ttc',
];

/** 行頭に置かない文字（追い出さずに前行へぶら下げる） */
const NO_LINE_START = new Set(
  '、。，．・：；！？）」』】〕》〉”’ゝゞーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ％‰℃）]}'.split(''),
);
/** 行末に置かない文字 */
const NO_LINE_END = new Set('（「『【〔《〈“‘([{'.split(''));

/** 縦書きで 90 度回転させる文字。長音・括弧類・英数・記号 */
const VERTICAL_ROTATE = /^[ー〜～（）()「」『』【】〔〕《》〈〉｛｝{}[\]:;=+<>~\-–—A-Za-z0-9,.%]$/;
/** 縦書きで字面を右上に寄せる文字 */
const VERTICAL_TOP_RIGHT = new Set('、。，．'.split(''));

export type FontRegistry = Map<string, string>;

/** パッケージルート。node_modules に入れたフォントを project.json から参照できるようにする */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** project.fonts の定義を登録し、キー -> 実際に使えるファミリ名の対応表を返す */
export function registerFonts(project: Project, projectDir: string): FontRegistry {
  const registry: FontRegistry = new Map();

  const tryRegister = (key: string, candidates: string[]): boolean => {
    for (const candidate of candidates) {
      // 相対パスは案件ディレクトリ → パッケージルートの順に探す。
      // 後者があるので "node_modules/@expo-google-fonts/..." をそのまま書ける
      const roots = path.isAbsolute(candidate) ? [''] : [projectDir, PACKAGE_ROOT];
      for (const root of roots) {
        const abs = root ? path.resolve(root, candidate) : candidate;
        if (!existsSync(abs)) continue;
        const family = `cg-${key}`;
        if (GlobalFonts.registerFromPath(abs, family)) {
          registry.set(key, family);
          return true;
        }
      }
    }
    return false;
  };

  for (const [key, candidates] of Object.entries(project.fonts)) {
    if (!tryRegister(key, candidates)) {
      console.warn(`[fonts] "${key}" のフォントが見つかりませんでした: ${candidates.join(', ')}`);
    }
  }

  if (!registry.has('default') && !tryRegister('default', BUILTIN_FONT_CANDIDATES)) {
    throw new Error(
      '日本語フォントが 1 つも見つかりませんでした。project.json の fonts.default にフォントファイルのパスを指定してください',
    );
  }

  return registry;
}

const warnedFontKeys = new Set<string>();

function familyOf(registry: FontRegistry, key: string): string {
  const family = registry.get(key);
  if (family) return family;

  // 黙って default に落ちると「別の書体で刷られた」ことに気づけないので必ず知らせる
  if (!warnedFontKeys.has(key)) {
    warnedFontKeys.add(key);
    console.warn(
      `[fonts] テンプレートが参照している "${key}" が project.json の fonts にありません。` +
        `default で代替します（利用可能: ${[...registry.keys()].join(', ')}）`,
    );
  }
  return registry.get('default')!;
}

/* ------------------------------------------------------------------ *
 * テキスト組版
 * ------------------------------------------------------------------ */

function measureChars(ctx: SKRSContext2D, chars: string[], letterSpacing: number): number {
  if (chars.length === 0) return 0;
  let width = 0;
  for (const ch of chars) width += ctx.measureText(ch).width;
  return width + letterSpacing * (chars.length - 1);
}

function wrapLine(
  ctx: SKRSContext2D,
  chars: string[],
  maxWidth: number,
  letterSpacing: number,
): string[][] {
  const lines: string[][] = [];
  let start = 0;

  while (start < chars.length) {
    let end = start + 1;
    while (end < chars.length && measureChars(ctx, chars.slice(start, end + 1), letterSpacing) <= maxWidth) {
      end++;
    }

    if (end < chars.length) {
      // 行頭禁則: 次行の先頭が句読点などなら現在行にぶら下げる
      while (end < chars.length && NO_LINE_START.has(chars[end]!)) end++;
      // 行末禁則: 現在行の末尾が始め括弧なら次行へ送る
      while (end - 1 > start && NO_LINE_END.has(chars[end - 1]!)) end--;
      if (end <= start) end = start + 1;
    }

    lines.push(chars.slice(start, end));
    start = end;
  }

  return lines;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

export interface Bitmap {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface TextBitmap extends Bitmap {
  lines: string[];
  fontSizePx: number;
  /** 縮小の下限まで詰めても maxLines に収まらなかった＝コピーが長すぎる */
  overflowedLines: boolean;
}

interface Layout {
  fontSize: number;
  letterSpacing: number;
  lines: string[][];
  lineWidths: number[];
  bandPadX: number;
  bandPadY: number;
  strokeWidth: number;
  margin: number;
}

/**
 * 帯の余白と縁取りの張り出しを差し引いた「文字が使える幅」で折り返す。
 * maxWidthPct はレイヤーの外寸なので、ここを引かないと帯が画面からはみ出す。
 */
function layoutAt(
  probe: SKRSContext2D,
  text: string,
  style: TextStyle,
  fontSize: number,
  family: string,
  outerMaxWidth: number,
): Layout {
  probe.font = `${fontSize}px "${family}"`;

  const letterSpacing = fontSize * style.letterSpacingEm;
  const strokeWidth = (fontSize * style.strokeWidthPct) / 100;
  const bandPadX = style.band ? fontSize * style.band.paddingXEm : 0;
  const bandPadY = style.band ? fontSize * style.band.paddingYEm : 0;
  const shadowReach = style.shadow
    ? fontSize * (style.shadow.blurEm + Math.abs(style.shadow.offsetXEm) + Math.abs(style.shadow.offsetYEm))
    : 0;
  const margin = Math.ceil(strokeWidth + shadowReach + 4);

  const textMaxWidth = Math.max(fontSize, outerMaxWidth - bandPadX * 2 - margin * 2);

  const lines: string[][] = [];
  for (const para of text.split('\n')) {
    const chars = Array.from(para);
    if (chars.length === 0) {
      lines.push([]);
      continue;
    }
    lines.push(...wrapLine(probe, chars, textMaxWidth, letterSpacing));
  }

  return {
    fontSize,
    letterSpacing,
    lines,
    lineWidths: lines.map((l) => measureChars(probe, l, letterSpacing)),
    bandPadX,
    bandPadY,
    strokeWidth,
    margin,
  };
}

/* ------------------------------------------------------------------ *
 * 縦書き
 * ------------------------------------------------------------------ */

interface VerticalLayout {
  fontSize: number;
  columns: string[][];
  cellAdvance: number;
  columnAdvance: number;
  strokeWidth: number;
  margin: number;
  padX: number;
  padY: number;
}

function layoutVerticalAt(
  text: string,
  style: TextStyle,
  fontSize: number,
  outerMaxHeight: number,
): VerticalLayout {
  // 和文は字面が正方形なので、送りは字幅を実測せず em 基準で決められる
  const cellAdvance = fontSize * (1 + style.letterSpacingEm);
  const columnAdvance = fontSize * style.lineHeight;

  const strokeWidth = (fontSize * style.strokeWidthPct) / 100;
  const padX = style.band ? fontSize * style.band.paddingXEm : 0;
  const padY = style.band ? fontSize * style.band.paddingYEm : 0;
  const shadowReach = style.shadow
    ? fontSize * (style.shadow.blurEm + Math.abs(style.shadow.offsetXEm) + Math.abs(style.shadow.offsetYEm))
    : 0;
  const margin = Math.ceil(strokeWidth + shadowReach + 4);

  const usableHeight = Math.max(cellAdvance, outerMaxHeight - padY * 2 - margin * 2);
  const perColumn = Math.max(1, Math.floor(usableHeight / cellAdvance));

  const columns: string[][] = [];
  for (const para of text.split('\n')) {
    const chars = Array.from(para);
    if (chars.length === 0) continue;
    for (let i = 0; i < chars.length; ) {
      let end = Math.min(i + perColumn, chars.length);
      if (end < chars.length) {
        // 列頭禁則: 次列の先頭が句読点などなら現在列にぶら下げる
        while (end < chars.length && NO_LINE_START.has(chars[end]!)) end++;
        while (end - 1 > i && NO_LINE_END.has(chars[end - 1]!)) end--;
        if (end <= i) end = i + 1;
      }
      columns.push(chars.slice(i, end));
      i = end;
    }
  }
  if (columns.length === 0) columns.push([]);

  return { fontSize, columns, cellAdvance, columnAdvance, strokeWidth, margin, padX, padY };
}

function renderVerticalText(
  overlay: TextOverlay,
  target: RenderTarget,
  fonts: FontRegistry,
): TextBitmap {
  const style = overlay.style;
  const family = familyOf(fonts, style.font);
  const outerMaxHeight = (target.height * overlay.maxHeightPct) / 100;

  const baseSize = Math.max(8, Math.round((target.height * style.sizePct) / 100));
  const minSize = Math.max(
    8,
    Math.round(style.minSizePct ? (target.height * style.minSizePct) / 100 : baseSize * 0.62),
  );

  // 列数がはみ出す限り少しずつ縮める（横書きと同じ考え方）
  let layout = layoutVerticalAt(overlay.text, style, baseSize, outerMaxHeight);
  if (overlay.maxLines) {
    let size = baseSize;
    while (layout.columns.length > overlay.maxLines && size > minSize) {
      size = Math.max(minSize, Math.floor(size * 0.96));
      layout = layoutVerticalAt(overlay.text, style, size, outerMaxHeight);
    }
  }

  const { fontSize, columns, cellAdvance, columnAdvance, strokeWidth, margin, padX, padY } = layout;
  const longest = Math.max(1, ...columns.map((c) => c.length));

  const width = Math.ceil(columnAdvance * columns.length + padX * 2 + margin * 2);
  const height = Math.ceil(cellAdvance * longest + padY * 2 + margin * 2);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px "${family}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  if (style.band) {
    ctx.fillStyle = style.band.color;
    roundRect(ctx, margin, margin, width - margin * 2, height - margin * 2, fontSize * style.band.radiusEm);
    ctx.fill();
  }

  const drawGlyph = (ch: string, cx: number, cy: number): void => {
    const rotate = VERTICAL_ROTATE.test(ch);
    ctx.save();
    if (VERTICAL_TOP_RIGHT.has(ch)) {
      // 句読点は枡目の右上に寄せる
      ctx.translate(cx + fontSize * 0.26, cy - fontSize * 0.28);
    } else {
      ctx.translate(cx, cy);
      if (rotate) ctx.rotate(Math.PI / 2);
    }
    if (strokeWidth > 0 && style.strokeColor) {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = strokeWidth * 2;
      ctx.strokeText(ch, 0, 0);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  };

  const drawAll = (): void => {
    columns.forEach((column, j) => {
      // 列は右から左へ進む
      const cx = width - margin - padX - columnAdvance * (j + 0.5);
      column.forEach((ch, k) => {
        drawGlyph(ch, cx, margin + padY + cellAdvance * (k + 0.5));
      });
    });
  };

  if (style.shadow) {
    ctx.save();
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = fontSize * style.shadow.blurEm;
    ctx.shadowOffsetX = fontSize * style.shadow.offsetXEm;
    ctx.shadowOffsetY = fontSize * style.shadow.offsetYEm;
    drawAll();
    ctx.restore();
  }
  drawAll();

  return {
    buffer: canvas.toBuffer('image/png'),
    width,
    height,
    lines: columns.map((c) => c.join('')),
    fontSizePx: fontSize,
    overflowedLines: Boolean(overlay.maxLines && columns.length > overlay.maxLines),
  };
}

export function renderText(overlay: TextOverlay, target: RenderTarget, fonts: FontRegistry): TextBitmap {
  if (overlay.style.writingMode === 'vertical') return renderVerticalText(overlay, target, fonts);

  const style: TextStyle = overlay.style;
  const family = familyOf(fonts, style.font);
  const outerMaxWidth = (target.width * overlay.maxWidthPct) / 100;

  const baseSize = Math.max(8, Math.round((target.height * style.sizePct) / 100));
  const minSize = Math.max(
    8,
    Math.round(style.minSizePct ? (target.height * style.minSizePct) / 100 : baseSize * 0.62),
  );

  // 実測用の捨てキャンバス
  const probe = createCanvas(8, 8).getContext('2d');

  // 行数がはみ出す限り少しずつ縮める。コピーが長い月でも枠が壊れない
  let layout = layoutAt(probe, overlay.text, style, baseSize, family, outerMaxWidth);
  if (overlay.maxLines) {
    let size = baseSize;
    while (layout.lines.length > overlay.maxLines && size > minSize) {
      size = Math.max(minSize, Math.floor(size * 0.96));
      layout = layoutAt(probe, overlay.text, style, size, family, outerMaxWidth);
    }
  }

  const { fontSize, letterSpacing, lines, lineWidths, bandPadX, bandPadY, strokeWidth, margin } = layout;
  const font = `${fontSize}px "${family}"`;

  const blockWidth = Math.max(1, ...lineWidths);
  const lineHeight = fontSize * style.lineHeight;
  const blockHeight = lineHeight * lines.length;

  const width = Math.ceil(blockWidth + bandPadX * 2 + margin * 2);
  const height = Math.ceil(blockHeight + bandPadY * 2 + margin * 2);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const lineStartX = (index: number): number => {
    const lw = lineWidths[index]!;
    switch (style.align) {
      case 'left':
        return margin + bandPadX;
      case 'right':
        return width - margin - bandPadX - lw;
      default:
        return (width - lw) / 2;
    }
  };

  // 帯（座布団）
  if (style.band) {
    ctx.fillStyle = style.band.color;
    const radius = fontSize * style.band.radiusEm;
    if (style.band.perLine) {
      lines.forEach((line, i) => {
        if (line.length === 0) return;
        const x = lineStartX(i) - bandPadX;
        const y = margin + lineHeight * i;
        roundRect(ctx, x, y, lineWidths[i]! + bandPadX * 2, lineHeight + bandPadY * 2, radius);
        ctx.fill();
      });
    } else {
      roundRect(ctx, margin, margin, width - margin * 2, height - margin * 2, radius);
      ctx.fill();
    }
  }

  const drawChars = (line: string[], startX: number, baselineY: number): void => {
    let x = startX;
    for (const ch of line) {
      if (strokeWidth > 0 && style.strokeColor) {
        ctx.strokeStyle = style.strokeColor;
        ctx.lineWidth = strokeWidth * 2; // strokeText は中心揃えなので外側幅の 2 倍を指定
        ctx.strokeText(ch, x, baselineY);
      }
      ctx.fillStyle = style.color;
      ctx.fillText(ch, x, baselineY);
      x += ctx.measureText(ch).width + letterSpacing;
    }
  };

  lines.forEach((line, i) => {
    if (line.length === 0) return;
    const startX = lineStartX(i);
    const baselineY = margin + bandPadY + lineHeight * i + lineHeight / 2;

    if (style.shadow) {
      ctx.save();
      ctx.shadowColor = style.shadow.color;
      ctx.shadowBlur = fontSize * style.shadow.blurEm;
      ctx.shadowOffsetX = fontSize * style.shadow.offsetXEm;
      ctx.shadowOffsetY = fontSize * style.shadow.offsetYEm;
      drawChars(line, startX, baselineY);
      ctx.restore();
    }
    drawChars(line, startX, baselineY);
  });

  return {
    buffer: canvas.toBuffer('image/png'),
    width,
    height,
    lines: lines.map((l) => l.join('')),
    fontSizePx: fontSize,
    overflowedLines: Boolean(overlay.maxLines && lines.length > overlay.maxLines),
  };
}

/* ------------------------------------------------------------------ *
 * 図形 / グラデーション / 画像
 * ------------------------------------------------------------------ */

export function renderBand(overlay: BandOverlay, target: RenderTarget): Bitmap {
  const width = Math.max(1, Math.round((target.width * overlay.widthPct) / 100));
  const height = Math.max(1, Math.round((target.height * overlay.heightPct) / 100));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = overlay.opacity;
  ctx.fillStyle = overlay.color;
  roundRect(ctx, 0, 0, width, height, (Math.min(width, height) * overlay.radiusPct) / 100);
  ctx.fill();
  return { buffer: canvas.toBuffer('image/png'), width, height };
}

function withAlpha(hexColor: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexColor.trim());
  if (!m) return hexColor;
  const n = Number.parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function renderScrim(overlay: ScrimOverlay, target: RenderTarget): Bitmap {
  const width = target.width;
  const height =
    overlay.side === 'full' ? target.height : Math.round((target.height * overlay.heightPct) / 100);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  if (overlay.side === 'full') {
    ctx.fillStyle = withAlpha(overlay.color, overlay.strength);
    ctx.fillRect(0, 0, width, height);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    const [from, to] =
      overlay.side === 'bottom'
        ? [withAlpha(overlay.color, 0), withAlpha(overlay.color, overlay.strength)]
        : [withAlpha(overlay.color, overlay.strength), withAlpha(overlay.color, 0)];
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  return { buffer: canvas.toBuffer('image/png'), width, height };
}

export async function renderImageOverlay(
  overlay: ImageOverlay,
  target: RenderTarget,
  projectDir: string,
): Promise<Bitmap> {
  const abs = path.isAbsolute(overlay.file) ? overlay.file : path.resolve(projectDir, overlay.file);
  if (!existsSync(abs)) throw new Error(`オーバーレイ画像が見つかりません: ${abs}`);

  const image = await loadImage(abs);
  const width = Math.max(1, Math.round((target.width * overlay.widthPct) / 100));
  const height = Math.max(1, Math.round((width * image.height) / image.width));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = overlay.opacity;
  ctx.drawImage(image, 0, 0, width, height);

  return { buffer: canvas.toBuffer('image/png'), width, height };
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export function place(
  anchor: Anchor,
  xPct: number,
  yPct: number,
  w: number,
  h: number,
  target: RenderTarget,
): { x: number; y: number } {
  const [vertical, horizontal] = anchor === 'center' ? ['center', 'center'] : anchor.split('-');

  const anchorX = horizontal === 'left' ? 0 : horizontal === 'right' ? target.width : target.width / 2;
  const anchorY = vertical === 'top' ? 0 : vertical === 'bottom' ? target.height : target.height / 2;

  const x = (horizontal === 'left' ? anchorX : horizontal === 'right' ? anchorX - w : anchorX - w / 2) +
    (target.width * xPct) / 100;
  const y = (vertical === 'top' ? anchorY : vertical === 'bottom' ? anchorY - h : anchorY - h / 2) +
    (target.height * yPct) / 100;

  return { x: Math.round(x), y: Math.round(y) };
}

export async function writeBitmap(bitmap: Bitmap, file: string): Promise<void> {
  await writeFile(file, bitmap.buffer);
}

/** scrim は anchor ではなく side で置く。それ以外は共通の place を使う */
export function placeOverlay(
  overlay: Overlay,
  bitmap: Bitmap,
  target: RenderTarget,
): { x: number; y: number } {
  if (overlay.kind === 'scrim') {
    const y = overlay.side === 'bottom' ? target.height - bitmap.height : 0;
    return { x: 0, y };
  }
  return place(overlay.anchor, overlay.xPct, overlay.yPct, bitmap.width, bitmap.height, target);
}
