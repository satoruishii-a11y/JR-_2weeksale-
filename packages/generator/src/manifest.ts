import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Layer, LayoutWarning, Timeline } from './timeline.js';
import type { Project, RatioKey, RenderTarget, ResolvedTemplate, VariantCombo } from './types.js';

/**
 * 生成時にしか分からない「確定した事実」を書き出す。
 *
 * 完成した動画を LLM に見せて付ける知覚タグ（訴求軸・トーンなど）と違い、
 * ここに入るのは推論を挟まない値なので欠損も揺れも起きない。
 * 分析側はこの JSON を主キー creative_id で実績と突き合わせるだけでよく、
 * 「動画とレポートの紐付け」という一番事故りやすい工程が人手から外れる。
 */

export interface DeterministicTags {
  aspect_ratio: RatioKey;
  width: number;
  height: number;
  fps: number;
  duration_sec: number;
  duration_bucket: string;

  scene_count: number;
  avg_shot_length_sec: number;
  cuts_per_10sec: number;
  pacing: 'fast' | 'medium' | 'slow';
  motion_types: string[];
  transition_types: string[];

  text_overlay_count: number;
  total_text_chars: number;
  headline_text: string | null;
  headline_chars: number;
  max_font_size_pct: number;
  /** 冒頭 3 秒に出ている文字数。離脱率との相関を見るための軸 */
  first3s_text_chars: number;
  first3s_scene_count: number;

  hook_type: string | null;
  cta_present: boolean;
  cta_text: string | null;
  cta_first_shown_sec: number | null;
  /** CTA が出るのが尺の何割地点か */
  cta_position_ratio: number | null;

  logo_present: boolean;
  bgm_present: boolean;
  scrim_used: boolean;

  assets_used: string[];
  asset_subjects: string[];
  palette: string[];

  safe_area_violations: number;
  /** コピーが枠に収まらず自動縮小の下限に当たった数 */
  text_overflow_warnings: number;
}

export interface Manifest {
  schema_version: '1.0';
  creative_id: string;
  generated_at: string;

  project: { slug: string; client: string; campaign: string };
  template: { id: string; name: string; version: string };
  variant: { hash: string; axes: Record<string, string> };

  output: {
    video: string;
    thumbnail: string | null;
    contact_sheet: string | null;
    bytes: number;
    sha256: string;
  };

  deterministic_tags: DeterministicTags;

  /** 再現に必要な最小限の設計図。素材を差し替えて同じ絵を再生成できる */
  reproduce: {
    scenes: Array<{
      index: number;
      asset: string;
      start: number;
      duration: number;
      motion: string;
      transition_in: string;
    }>;
    overlays: Array<{
      id: string;
      kind: string;
      role: string | null;
      text: string | null;
      start: number;
      end: number;
      anchor_x: number;
      anchor_y: number;
    }>;
  };

  warnings: LayoutWarning[];
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function durationBucket(seconds: number): string {
  if (seconds <= 6.5) return '6s';
  if (seconds <= 11) return '10s';
  if (seconds <= 16.5) return '15s';
  if (seconds <= 22) return '20s';
  if (seconds <= 32) return '30s';
  if (seconds <= 65) return '60s';
  return '60s+';
}

function pacingOf(avgShotLength: number): 'fast' | 'medium' | 'slow' {
  if (avgShotLength < 1.8) return 'fast';
  if (avgShotLength < 3.2) return 'medium';
  return 'slow';
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

export interface BuildManifestInput {
  creativeId: string;
  project: Project;
  template: ResolvedTemplate;
  variant: VariantCombo;
  target: RenderTarget;
  ratio: RatioKey;
  timeline: Timeline;
  layers: Layer[];
  warnings: LayoutWarning[];
  videoFile: string;
  thumbnailFile: string | null;
  contactSheetFile: string | null;
  generatedAt: string;
  /** 実際に合成された BGM の絶対パス。無音なら undefined */
  bgmFile?: string;
}

export async function buildManifest(input: BuildManifestInput): Promise<Manifest> {
  const { template, timeline, layers, target, project } = input;

  const textLayers = layers.filter((l) => l.kind === 'text');
  const totalTextChars = textLayers.reduce((sum, l) => sum + (l.text?.replace(/\s/g, '').length ?? 0), 0);
  const first3s = textLayers.filter((l) => l.start < 3);
  const headline = textLayers.find((l) => l.role === 'headline') ?? textLayers[0];
  const ctaLayers = textLayers.filter((l) => l.role === 'cta').sort((a, b) => a.start - b.start);
  const cta = ctaLayers[0];

  const avgShotLength = Number((timeline.total / template.scenes.length).toFixed(2));
  const stats = await stat(input.videoFile);

  const assetsUsed = uniq(template.scenes.map((s) => s.asset));
  const assetSubjects = uniq(
    assetsUsed
      .map((id) => project.assets.find((a) => a.id === id)?.subject)
      .filter((s): s is string => Boolean(s)),
  );

  // ブランド色に加えて、実際にテロップで使われた色も拾う（配色軸として分析に効く）
  const palette = uniq(
    [project.brand.primary, project.brand.accent, ...textLayers.map((l) => l.color ?? '')]
      .filter(Boolean)
      .map((c) => c.toUpperCase()),
  );

  const tags: DeterministicTags = {
    aspect_ratio: input.ratio,
    width: target.width,
    height: target.height,
    fps: target.fps,
    duration_sec: timeline.total,
    duration_bucket: durationBucket(timeline.total),

    scene_count: template.scenes.length,
    avg_shot_length_sec: avgShotLength,
    cuts_per_10sec: Number(((template.scenes.length / timeline.total) * 10).toFixed(2)),
    pacing: pacingOf(avgShotLength),
    motion_types: uniq(template.scenes.map((s) => s.motion)),
    transition_types: uniq(template.scenes.slice(1).map((s) => s.transitionIn)),

    text_overlay_count: textLayers.length,
    total_text_chars: totalTextChars,
    headline_text: headline?.text ?? null,
    headline_chars: headline?.text?.replace(/\s/g, '').length ?? 0,
    max_font_size_pct: textLayers.reduce((max, l) => Math.max(max, l.fontSizePct ?? 0), 0),
    first3s_text_chars: first3s.reduce((sum, l) => sum + (l.text?.replace(/\s/g, '').length ?? 0), 0),
    first3s_scene_count: timeline.scenes.filter((s) => s.start < 3).length,

    hook_type: template.hookType ?? input.variant.axes['hook'] ?? null,
    cta_present: Boolean(cta),
    cta_text: cta?.text ?? null,
    cta_first_shown_sec: cta ? cta.start : null,
    cta_position_ratio: cta ? Number((cta.start / timeline.total).toFixed(3)) : null,

    logo_present: layers.some((l) => l.role === 'logo'),
    bgm_present: Boolean(input.bgmFile),
    scrim_used: layers.some((l) => l.kind === 'scrim'),

    assets_used: assetsUsed,
    asset_subjects: assetSubjects,
    palette,

    safe_area_violations: input.warnings.filter((w) => w.type === 'safe-area').length,
    text_overflow_warnings: input.warnings.filter((w) => w.type === 'text-overflow').length,
  };

  return {
    schema_version: '1.0',
    creative_id: input.creativeId,
    generated_at: input.generatedAt,
    project: { slug: project.slug, client: project.client, campaign: project.campaign },
    template: { id: template.id, name: template.name, version: template.version },
    variant: { hash: input.variant.hash, axes: input.variant.axes },
    output: {
      video: input.videoFile,
      thumbnail: input.thumbnailFile,
      contact_sheet: input.contactSheetFile,
      bytes: stats.size,
      sha256: await sha256File(input.videoFile),
    },
    deterministic_tags: tags,
    reproduce: {
      scenes: template.scenes.map((scene, i) => ({
        index: i,
        asset: scene.asset,
        start: timeline.scenes[i]!.start,
        duration: scene.duration,
        motion: scene.motion,
        transition_in: i === 0 ? 'none' : scene.transitionIn,
      })),
      overlays: layers.map((l) => ({
        id: l.id,
        kind: l.kind,
        role: l.role ?? null,
        text: l.text ?? null,
        start: l.start,
        end: l.end,
        anchor_x: l.x,
        anchor_y: l.y,
      })),
    },
    warnings: input.warnings,
  };
}

/* ------------------------------------------------------------------ *
 * CSV / BigQuery 取り込み用のフラット化
 * ------------------------------------------------------------------ */

export const CSV_COLUMNS = [
  'creative_id',
  'generated_at',
  'client',
  'campaign',
  'template_id',
  'template_version',
  'variant_hash',
  'variant_axes',
  'aspect_ratio',
  'duration_sec',
  'duration_bucket',
  'scene_count',
  'avg_shot_length_sec',
  'pacing',
  'motion_types',
  'transition_types',
  'text_overlay_count',
  'total_text_chars',
  'headline_text',
  'headline_chars',
  'max_font_size_pct',
  'first3s_text_chars',
  'hook_type',
  'cta_present',
  'cta_text',
  'cta_first_shown_sec',
  'cta_position_ratio',
  'logo_present',
  'bgm_present',
  'assets_used',
  'asset_subjects',
  'safe_area_violations',
  'text_overflow_warnings',
  'video_path',
  'sha256',
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join('|') : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function manifestsToCsv(manifests: Manifest[]): string {
  const rows = manifests.map((m) => {
    const t = m.deterministic_tags;
    const record: Record<string, unknown> = {
      creative_id: m.creative_id,
      generated_at: m.generated_at,
      client: m.project.client,
      campaign: m.project.campaign,
      template_id: m.template.id,
      template_version: m.template.version,
      variant_hash: m.variant.hash,
      variant_axes: Object.entries(m.variant.axes)
        .map(([k, v]) => `${k}=${v}`)
        .join('|'),
      video_path: m.output.video,
      sha256: m.output.sha256,
      ...t,
    };
    return CSV_COLUMNS.map((col) => csvCell(record[col])).join(',');
  });

  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}
