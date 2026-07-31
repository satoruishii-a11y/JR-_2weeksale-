import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  placeOverlay,
  renderBand,
  renderImageOverlay,
  renderScrim,
  renderText,
  writeBitmap,
  type FontRegistry,
} from './draw.js';
import {
  SAFE_AREA_PROFILES,
  type Overlay,
  type RatioKey,
  type RenderTarget,
  type ResolvedTemplate,
  type SafeAreaProfile,
} from './types.js';

export interface SceneTiming {
  index: number;
  /** 完成尺の中でこのシーンが見え始める秒 */
  start: number;
  duration: number;
  end: number;
  /** 直前シーンとの重なり秒（scenes[0] は 0） */
  transitionDuration: number;
}

export interface Timeline {
  scenes: SceneTiming[];
  total: number;
}

/**
 * xfade は前後のシーンを重ねるので、完成尺は単純な合計より短くなる。
 * 決定タグの duration / 平均ショット長はここで出した値を正とする。
 */
export function computeTimeline(template: ResolvedTemplate): Timeline {
  const scenes: SceneTiming[] = [];
  let cursor = 0;

  template.scenes.forEach((scene, index) => {
    let overlap = 0;
    if (index > 0) {
      const prev = template.scenes[index - 1]!;
      const requested = scene.transitionIn === 'cut' ? 1 / template.fps : scene.transitionDuration;
      // 隣り合うシーンより長い重なりは取れない
      overlap = Math.min(requested, prev.duration * 0.8, scene.duration * 0.8);
      cursor = cursor + prev.duration - overlap;
    }
    scenes.push({ index, start: cursor, duration: scene.duration, end: cursor + scene.duration, transitionDuration: overlap });
  });

  const last = scenes[scenes.length - 1]!;
  return { scenes, total: Number((last.start + last.duration).toFixed(3)) };
}

export interface Layer {
  id: string;
  kind: Overlay['kind'];
  /** 焼き付けた PNG の絶対パス */
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
  anim: Overlay['anim'];
  animDuration: number;
  outDuration: number;
  /* --- 決定タグ用のメタ --- */
  role?: string;
  text?: string;
  lines?: string[];
  fontSizePct?: number;
  /** テロップの文字色。配色タグに使う */
  color?: string;
  sceneIndex?: number;
}

export interface LayoutWarning {
  /** safe-area: UI に隠れる位置にある / text-overflow: コピーが枠に収まらない */
  type: 'safe-area' | 'text-overflow';
  layerId: string;
  role?: string;
  text?: string;
  detail: string;
}

export interface BuiltLayers {
  layers: Layer[];
  warnings: LayoutWarning[];
}

function checkSafeArea(
  layer: Layer,
  ratio: RatioKey,
  target: RenderTarget,
  profile: SafeAreaProfile,
): LayoutWarning | null {
  const sa = SAFE_AREA_PROFILES[profile][ratio];
  const top = (target.height * sa.top) / 100;
  const bottom = target.height - (target.height * sa.bottom) / 100;
  const left = (target.width * sa.left) / 100;
  const right = target.width - (target.width * sa.right) / 100;

  // 配置は整数画素に丸めているので、1px 未満のズレは警告にしない
  const TOLERANCE = 1;
  const over: string[] = [];
  if (top - layer.y > TOLERANCE) over.push(`上 ${Math.round(top - layer.y)}px`);
  if (layer.y + layer.height - bottom > TOLERANCE) over.push(`下 ${Math.round(layer.y + layer.height - bottom)}px`);
  if (left - layer.x > TOLERANCE) over.push(`左 ${Math.round(left - layer.x)}px`);
  if (layer.x + layer.width - right > TOLERANCE) over.push(`右 ${Math.round(layer.x + layer.width - right)}px`);

  if (over.length === 0) return null;
  return {
    type: 'safe-area',
    layerId: layer.id,
    role: layer.role,
    text: layer.text,
    detail: `${over.join(' / ')} はみ出し`,
  };
}

/**
 * シーン相対の時間指定を絶対秒に直しつつ、各オーバーレイを PNG に焼く。
 * セーフエリアからはみ出したテキストはここで検出して警告に積む。
 */
export async function buildLayers(
  template: ResolvedTemplate,
  timeline: Timeline,
  target: RenderTarget,
  ratio: RatioKey,
  fonts: FontRegistry,
  projectDir: string,
  workDir: string,
  safeAreaProfile: SafeAreaProfile,
): Promise<BuiltLayers> {
  await mkdir(workDir, { recursive: true });

  const layers: Layer[] = [];
  const warnings: LayoutWarning[] = [];
  let seq = 0;

  const emit = async (overlay: Overlay, absStart: number, absEnd: number, sceneIndex?: number) => {
    const id = overlay.id ?? `${overlay.kind}${seq}`;
    const file = path.join(workDir, `layer-${String(seq).padStart(3, '0')}-${overlay.kind}.png`);
    seq++;

    let bitmap;
    let meta: Partial<Layer> = {};
    let overflowed = false;

    switch (overlay.kind) {
      case 'text': {
        const rendered = renderText(overlay, target, fonts);
        bitmap = rendered;
        overflowed = rendered.overflowedLines;
        meta = {
          role: overlay.role,
          text: overlay.text,
          lines: rendered.lines,
          fontSizePct: Number(((rendered.fontSizePx / target.height) * 100).toFixed(2)),
          color: overlay.style.color,
        };
        break;
      }
      case 'image':
        bitmap = await renderImageOverlay(overlay, target, projectDir);
        meta = { role: overlay.role };
        break;
      case 'band':
        bitmap = renderBand(overlay, target);
        break;
      case 'scrim':
        bitmap = renderScrim(overlay, target);
        break;
    }

    await writeBitmap(bitmap, file);
    const { x, y } = placeOverlay(overlay, bitmap, target);

    const layer: Layer = {
      id,
      kind: overlay.kind,
      file,
      x,
      y,
      width: bitmap.width,
      height: bitmap.height,
      start: Math.max(0, Number(absStart.toFixed(3))),
      end: Math.min(timeline.total, Number(absEnd.toFixed(3))),
      anim: overlay.anim,
      animDuration: overlay.animDuration,
      outDuration: overlay.outDuration,
      sceneIndex,
      ...meta,
    };

    if (layer.end > layer.start) {
      layers.push(layer);
      if (!overlay.ignoreSafeArea && overlay.kind !== 'scrim') {
        const warning = checkSafeArea(layer, ratio, target, safeAreaProfile);
        if (warning) warnings.push(warning);
      }
      if (overflowed && overlay.kind === 'text') {
        warnings.push({
          type: 'text-overflow',
          layerId: id,
          role: overlay.role,
          text: overlay.text,
          detail:
            `${overlay.maxLines} 行に収まらず ${layer.lines?.length} 行になりました` +
            `（${layer.lines?.map((l) => `「${l}」`).join('')}）。コピーを短くするか maxWidthPct を広げてください`,
        });
      }
    }
  };

  // シーン付きオーバーレイ（時間はシーン先頭からの相対）
  for (const [index, scene] of template.scenes.entries()) {
    const timing = timeline.scenes[index]!;
    for (const overlay of scene.overlays) {
      const start = timing.start + overlay.start;
      const end = timing.start + (overlay.end ?? scene.duration);
      await emit(overlay, start, end, index);
    }
  }

  // 全体オーバーレイ（時間は動画先頭からの絶対）
  for (const overlay of template.overlays) {
    await emit(overlay, overlay.start, overlay.end ?? timeline.total);
  }

  return { layers, warnings };
}
