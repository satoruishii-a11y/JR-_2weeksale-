import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import type { Layer, Timeline } from './timeline.js';
import type { RenderTarget, ResolvedTemplate, Scene } from './types.js';

const run = promisify(execFile);

export const FFMPEG_BIN: string = process.env['FFMPEG_PATH'] ?? (ffmpegStatic as unknown as string);

/** フィルタグラフに埋める数値。桁を落として読みやすくする */
function n(value: number): string {
  return Number(value.toFixed(4)).toString();
}

/**
 * Ken Burns。静止画をそのまま出すと「素材を並べただけ」に見えるので、
 * シーンごとに寄り引き・パンを付けて動画としての体裁を作る。
 *
 * zoompan は x/y を整数に丸めるため、等倍のまま動かすと 1px 単位で
 * カクつく。キャンバスより大きく先読みスケールしてから切り出すことで、
 * 丸め幅が実質的に縮んで滑らかに見える。
 */
const MOTION_SUPERSAMPLE = 1.6;

function motionChain(scene: Scene, target: RenderTarget): { pre: string; motion: string } {
  const { width, height, fps } = target;

  if (scene.motion === 'still') {
    return {
      pre: `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
      motion: `fps=${fps}`,
    };
  }

  // x264 が扱いやすいよう偶数に揃える
  const superW = Math.round((width * MOTION_SUPERSAMPLE) / 2) * 2;
  const superH = Math.round((height * MOTION_SUPERSAMPLE) / 2) * 2;
  const pre = `scale=${superW}:${superH}:force_original_aspect_ratio=increase,crop=${superW}:${superH}`;

  const frames = Math.max(2, Math.round(scene.duration * fps));
  const last = frames - 1;
  const intensity = scene.motionIntensity;

  // ズーム系は控えめに、パン系は動く余白が要るので少し強めに寄せる
  const zoomMax = 1 + 0.06 + 0.1 * intensity;
  const panZoom = 1.1 + 0.1 * intensity;

  const centerX = `iw/2-(iw/zoom/2)`;
  const centerY = `ih/2-(ih/zoom/2)`;
  const progress = `on/${n(last)}`;

  let z: string;
  let x: string;
  let y: string;

  switch (scene.motion) {
    case 'zoom-in':
      z = `min(1+${n(zoomMax - 1)}*${progress},${n(zoomMax)})`;
      x = centerX;
      y = centerY;
      break;
    case 'zoom-out':
      z = `max(${n(zoomMax)}-${n(zoomMax - 1)}*${progress},1)`;
      x = centerX;
      y = centerY;
      break;
    case 'pan-right':
      z = n(panZoom);
      x = `(iw-iw/zoom)*${progress}`;
      y = centerY;
      break;
    case 'pan-left':
      z = n(panZoom);
      x = `(iw-iw/zoom)*(1-${progress})`;
      y = centerY;
      break;
    case 'pan-down':
      z = n(panZoom);
      x = centerX;
      y = `(ih-ih/zoom)*${progress}`;
      break;
    case 'pan-up':
      z = n(panZoom);
      x = centerX;
      y = `(ih-ih/zoom)*(1-${progress})`;
      break;
  }

  return {
    pre,
    motion: `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`,
  };
}

function gradeChain(scene: Scene): string[] {
  if (!scene.grade) return [];
  const { brightness, contrast, saturation, blurPx } = scene.grade;
  const filters: string[] = [];
  if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
    filters.push(`eq=brightness=${n(brightness)}:contrast=${n(contrast)}:saturation=${n(saturation)}`);
  }
  if (blurPx > 0) filters.push(`gblur=sigma=${n(blurPx)}`);
  return filters;
}

/** 0→1 に張り付くクランプ済み進捗。スライドインの補間に使う */
function clampedProgress(start: number, duration: number): string {
  if (duration <= 0) return '1';
  return `min(max((t-${n(start)})/${n(duration)},0),1)`;
}

function overlayPosition(layer: Layer, target: RenderTarget): { x: string; y: string } {
  const slide = Math.round(Math.min(target.width, target.height) * 0.04);
  const p = clampedProgress(layer.start, layer.animDuration);

  switch (layer.anim) {
    case 'slide-up':
      return { x: n(layer.x), y: `${n(layer.y)}+${slide}*(1-${p})` };
    case 'slide-down':
      return { x: n(layer.x), y: `${n(layer.y)}-${slide}*(1-${p})` };
    case 'slide-left':
      return { x: `${n(layer.x)}+${slide}*(1-${p})`, y: n(layer.y) };
    case 'slide-right':
      return { x: `${n(layer.x)}-${slide}*(1-${p})`, y: n(layer.y) };
    default:
      return { x: n(layer.x), y: n(layer.y) };
  }
}

export interface BuildArgsInput {
  template: ResolvedTemplate;
  target: RenderTarget;
  timeline: Timeline;
  /** scenes と同じ並びの画像絶対パス */
  sceneFiles: string[];
  layers: Layer[];
  bgmFile?: string;
  outFile: string;
  /** x264 プリセット。下書きは veryfast、納品は medium/slow */
  preset?: string;
  crf?: number;
}

export function buildFfmpegArgs(input: BuildArgsInput): string[] {
  const { template, target, timeline, sceneFiles, layers, bgmFile, outFile } = input;
  const preset = input.preset ?? 'medium';
  const crf = input.crf ?? 20;
  const { fps } = target;
  const total = timeline.total;

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error', '-stats'];

  // --- 入力 ---
  template.scenes.forEach((scene, i) => {
    args.push('-framerate', String(fps), '-loop', '1', '-t', n(scene.duration), '-i', sceneFiles[i]!);
  });
  for (const layer of layers) {
    args.push('-framerate', String(fps), '-loop', '1', '-t', n(total), '-i', layer.file);
  }

  const audioInputIndex = template.scenes.length + layers.length;
  if (bgmFile) {
    args.push('-stream_loop', '-1', '-i', bgmFile);
  } else {
    // 無音でもトラックは必ず載せる（音声なしを弾く配信面があるため）
    args.push('-f', 'lavfi', '-t', n(total), '-i', 'anullsrc=r=48000:cl=stereo');
  }

  // --- シーン ---
  const chains: string[] = [];
  template.scenes.forEach((scene, i) => {
    const { pre, motion } = motionChain(scene, target);
    const parts = [pre, motion, ...gradeChain(scene), 'setsar=1', 'format=yuv420p'];
    chains.push(`[${i}:v]${parts.join(',')}[s${i}]`);
  });

  // --- トランジション ---
  let videoLabel = 's0';
  for (let i = 1; i < template.scenes.length; i++) {
    const scene = template.scenes[i]!;
    const timing = timeline.scenes[i]!;
    const transition = scene.transitionIn === 'cut' ? 'fade' : scene.transitionIn;
    const duration = Math.max(1 / fps, timing.transitionDuration);
    const offset = timing.start;
    const out = `x${i}`;
    chains.push(
      `[${videoLabel}][s${i}]xfade=transition=${transition}:duration=${n(duration)}:offset=${n(offset)}[${out}]`,
    );
    videoLabel = out;
  }

  // --- オーバーレイ ---
  layers.forEach((layer, j) => {
    const inputIndex = template.scenes.length + j;
    const fadeIn = layer.anim === 'none' ? 0 : layer.animDuration;
    const fadeOut = layer.outDuration;

    const prep = ['format=rgba'];
    if (fadeIn > 0) prep.push(`fade=t=in:st=${n(layer.start)}:d=${n(fadeIn)}:alpha=1`);
    if (fadeOut > 0 && layer.end - fadeOut > layer.start) {
      prep.push(`fade=t=out:st=${n(layer.end - fadeOut)}:d=${n(fadeOut)}:alpha=1`);
    }
    chains.push(`[${inputIndex}:v]${prep.join(',')}[o${j}]`);

    const { x, y } = overlayPosition(layer, target);
    const out = `ov${j}`;
    chains.push(
      `[${videoLabel}][o${j}]overlay=x='${x}':y='${y}':enable='between(t,${n(layer.start)},${n(layer.end)})':format=yuv420[${out}]`,
    );
    videoLabel = out;
  });

  // 最終出力が H.264 の 4:2:0 なので、チェーン全体を yuv420p で通す。
  // 中間だけ 4:4:4 にしても最後に落とされるうえ、実測で 1.5 倍遅くなった。
  chains.push(`[${videoLabel}]format=yuv420p,fps=${fps}[vout]`);

  // --- 音声 ---
  const audio = template.audio;
  const audioParts = [
    `atrim=0:${n(total)}`,
    'asetpts=PTS-STARTPTS',
    `volume=${n(bgmFile ? audio.volume : 0)}`,
  ];
  if (bgmFile) {
    if (audio.fadeIn > 0) audioParts.push(`afade=t=in:st=0:d=${n(audio.fadeIn)}`);
    if (audio.fadeOut > 0 && total - audio.fadeOut > 0) {
      audioParts.push(`afade=t=out:st=${n(total - audio.fadeOut)}:d=${n(audio.fadeOut)}`);
    }
  }
  audioParts.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
  chains.push(`[${audioInputIndex}:a]${audioParts.join(',')}[aout]`);

  args.push('-filter_complex', chains.join(';'));
  args.push(
    '-map', '[vout]',
    '-map', '[aout]',
    '-t', n(total),
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    outFile,
  );

  return args;
}

export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await run(FFMPEG_BIN, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`ffmpeg が失敗しました:\n${err.stderr?.trim() || err.message}`);
  }
}

/** サムネイル（YouTube のカスタムサムネや社内レビュー一覧に使う） */
export async function extractThumbnail(videoFile: string, atSecond: number, outFile: string): Promise<void> {
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', n(atSecond),
    '-i', videoFile,
    '-frames:v', '1',
    '-q:v', '3',
    outFile,
  ]);
}

/** 冒頭の掴みをレビューするためのコンタクトシート */
export async function extractContactSheet(
  videoFile: string,
  outFile: string,
  columns = 5,
  everySeconds = 1,
): Promise<void> {
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoFile,
    '-vf', `fps=1/${n(everySeconds)},scale=320:-1,tile=${columns}x2`,
    '-frames:v', '1',
    '-q:v', '4',
    outFile,
  ]);
}
