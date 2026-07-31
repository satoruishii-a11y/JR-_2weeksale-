import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerFonts, type FontRegistry } from './draw.js';
import { buildFfmpegArgs, extractContactSheet, extractThumbnail, runFfmpeg } from './ffmpeg.js';
import { buildManifest, manifestsToCsv, type Manifest } from './manifest.js';
import { resolveNode } from './resolve.js';
import { buildLayers, computeTimeline } from './timeline.js';
import {
  ProjectSchema,
  RATIO_PRESETS,
  RawTemplateSchema,
  ResolvedTemplateSchema,
  type Project,
  type RatioKey,
  type RawTemplate,
  type RenderTarget,
  type ResolvedTemplate,
  type SafeAreaProfile,
  type VariantCombo,
} from './types.js';
import { axisBalance, creativeId, expandVariants, type Strategy } from './variants.js';
import { renderReviewPage } from './review-page.js';

export interface RenderOptions {
  projectDir: string;
  templateFile: string;
  outDir: string;
  strategy: Strategy;
  ratios: RatioKey[];
  seed?: string;
  dryRun?: boolean;
  concurrency?: number;
  contactSheet?: boolean;
  keepWork?: boolean;
  safeAreaProfile?: SafeAreaProfile;
  preset?: string;
  crf?: number;
}

export interface BatchResult {
  manifests: Manifest[];
  variants: VariantCombo[];
  balance: Record<string, Record<string, number>>;
  outDir: string;
  skipped: Array<{ creativeId: string; reason: string }>;
}

async function readJson<T>(file: string): Promise<T> {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`JSON として読めません: ${file}\n${(error as Error).message}`);
  }
}

export async function loadProject(projectDir: string): Promise<Project> {
  const file = path.join(projectDir, 'project.json');
  if (!existsSync(file)) throw new Error(`project.json が見つかりません: ${file}`);
  const parsed = ProjectSchema.safeParse(await readJson(file));
  if (!parsed.success) {
    throw new Error(`project.json の内容が不正です:\n${formatZodError(parsed.error.issues)}`);
  }
  return parsed.data;
}

export async function loadTemplate(templateFile: string): Promise<RawTemplate> {
  if (!existsSync(templateFile)) throw new Error(`テンプレートが見つかりません: ${templateFile}`);
  const parsed = RawTemplateSchema.safeParse(await readJson(templateFile));
  if (!parsed.success) {
    throw new Error(`テンプレートの内容が不正です:\n${formatZodError(parsed.error.issues)}`);
  }
  return parsed.data;
}

function formatZodError(issues: Array<{ path: (string | number)[]; message: string }>): string {
  return issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

/** シーンの asset id を実ファイルの絶対パスに解決する */
function resolveSceneFiles(template: ResolvedTemplate, project: Project, projectDir: string): string[] {
  return template.scenes.map((scene, index) => {
    const asset = project.assets.find((a) => a.id === scene.asset);
    if (!asset) {
      const known = project.assets.map((a) => a.id).join(', ');
      throw new Error(`scenes[${index}].asset "${scene.asset}" が project.assets にありません（利用可能: ${known}）`);
    }
    const abs = path.isAbsolute(asset.file) ? asset.file : path.resolve(projectDir, asset.file);
    if (!existsSync(abs)) throw new Error(`素材ファイルが見つかりません: ${abs}`);
    return abs;
  });
}

function resolveBgm(template: ResolvedTemplate, project: Project, projectDir: string): string | undefined {
  const ref = template.audio.bgm ?? project.bgm;
  if (!ref) return undefined;
  const abs = path.isAbsolute(ref) ? ref : path.resolve(projectDir, ref);
  if (!existsSync(abs)) {
    console.warn(`[bgm] 見つからないので無音で出力します: ${abs}`);
    return undefined;
  }
  return abs;
}

interface Job {
  variant: VariantCombo;
  ratio: RatioKey;
  id: string;
}

/** 単純な並列実行プール。ffmpeg は CPU を食うので既定は論理コアの半分 */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function renderOne(
  job: Job,
  raw: RawTemplate,
  project: Project,
  projectDir: string,
  options: RenderOptions,
  fonts: FontRegistry,
  generatedAt: string,
): Promise<Manifest> {
  const { ratio, variant } = job;
  const preset = RATIO_PRESETS[ratio];

  // 1) 軸とアスペクト比を埋めて具体化する
  const resolvedRaw = resolveNode(raw, { axes: variant.axes, ratio, project, root: raw });
  const parsed = ResolvedTemplateSchema.safeParse(resolvedRaw);
  if (!parsed.success) {
    throw new Error(`解決後のテンプレートが不正です (${job.id}):\n${formatZodError(parsed.error.issues)}`);
  }
  const template: ResolvedTemplate = parsed.data;
  const target: RenderTarget = { ratio, width: preset.width, height: preset.height, fps: template.fps };

  // 2) 尺とレイヤーを確定
  const timeline = computeTimeline(template);
  const sceneFiles = resolveSceneFiles(template, project, projectDir);
  const workDir = path.join(options.outDir, '.work', job.id);
  const { layers, warnings } = await buildLayers(
    template, timeline, target, ratio, fonts, projectDir, workDir,
    options.safeAreaProfile ?? 'instream',
  );

  // 3) 描画
  const videoDir = path.join(options.outDir, 'videos');
  const metaDir = path.join(options.outDir, 'manifests');
  await mkdir(videoDir, { recursive: true });
  await mkdir(metaDir, { recursive: true });

  const videoFile = path.join(videoDir, `${job.id}.mp4`);
  const thumbFile = path.join(videoDir, `${job.id}.jpg`);
  const sheetFile = path.join(videoDir, `${job.id}-sheet.jpg`);

  const bgmFile = resolveBgm(template, project, projectDir);
  const args = buildFfmpegArgs({
    template,
    target,
    timeline,
    sceneFiles,
    layers,
    bgmFile,
    outFile: videoFile,
    preset: options.preset,
    crf: options.crf,
  });

  await runFfmpeg(args);
  await extractThumbnail(videoFile, Math.min(1.2, timeline.total / 3), thumbFile);
  if (options.contactSheet) {
    await extractContactSheet(videoFile, sheetFile, 5, Math.max(1, timeline.total / 10));
  }

  // 4) 決定タグを書き出す
  const manifest = await buildManifest({
    creativeId: job.id,
    project,
    template,
    variant,
    target,
    ratio,
    timeline,
    layers,
    warnings,
    videoFile,
    thumbnailFile: thumbFile,
    contactSheetFile: options.contactSheet ? sheetFile : null,
    generatedAt,
    bgmFile,
  });

  // パスは outDir 相対にして持ち運べるようにする
  manifest.output.video = path.relative(options.outDir, videoFile);
  manifest.output.thumbnail = path.relative(options.outDir, thumbFile);
  manifest.output.contact_sheet = options.contactSheet ? path.relative(options.outDir, sheetFile) : null;

  await writeFile(path.join(metaDir, `${job.id}.json`), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (!options.keepWork) await rm(workDir, { recursive: true, force: true });

  return manifest;
}

export interface LayoutReport {
  creativeId: string;
  ratio: RatioKey;
  duration: number;
  texts: Array<{ role: string; lines: string[]; sizePct: number; box: string }>;
  warnings: BuiltLayers['warnings'];
}

type BuiltLayers = Awaited<ReturnType<typeof buildLayers>>;

/**
 * ffmpeg を回さずに組版だけ検証する。
 * テンプレートを触るたびに 15 分待つのは現実的でないので、
 * 「文字が何行になるか」「セーフエリアを踏んでいないか」だけを数秒で返す。
 */
export async function checkLayouts(options: RenderOptions): Promise<LayoutReport[]> {
  const projectDir = path.resolve(options.projectDir);
  const project = await loadProject(projectDir);
  const raw = await loadTemplate(path.resolve(options.templateFile));
  const fonts = registerFonts(project, projectDir);
  const variants = expandVariants(raw, options.strategy, options.seed);
  const workRoot = path.join(options.outDir, '.layout');
  const reports: LayoutReport[] = [];

  for (const variant of variants) {
    for (const ratio of options.ratios) {
      const preset = RATIO_PRESETS[ratio];
      const resolved = resolveNode(raw, { axes: variant.axes, ratio, project, root: raw });
      const parsed = ResolvedTemplateSchema.safeParse(resolved);
      if (!parsed.success) {
        throw new Error(`解決後のテンプレートが不正です:\n${formatZodError(parsed.error.issues)}`);
      }
      const template = parsed.data;
      const target: RenderTarget = { ratio, width: preset.width, height: preset.height, fps: template.fps };
      const timeline = computeTimeline(template);
      const id = creativeId(project.slug, raw.id, variant.hash, ratio);
      const { layers, warnings } = await buildLayers(
        template, timeline, target, ratio, fonts, projectDir,
        path.join(workRoot, id), options.safeAreaProfile ?? 'instream',
      );

      reports.push({
        creativeId: id,
        ratio,
        duration: timeline.total,
        texts: layers
          .filter((l) => l.kind === 'text')
          .map((l) => ({
            role: l.role ?? '-',
            lines: l.lines ?? [],
            sizePct: l.fontSizePct ?? 0,
            box: `${l.width}x${l.height} @${l.x},${l.y}`,
          })),
        warnings,
      });
    }
  }

  await rm(workRoot, { recursive: true, force: true });
  return reports;
}

export async function renderBatch(options: RenderOptions): Promise<BatchResult> {
  const projectDir = path.resolve(options.projectDir);
  const project = await loadProject(projectDir);
  const raw = await loadTemplate(path.resolve(options.templateFile));
  const fonts = registerFonts(project, projectDir);

  const variants = expandVariants(raw, options.strategy, options.seed);
  const balance = axisBalance(variants);

  const jobs: Job[] = [];
  for (const variant of variants) {
    for (const ratio of options.ratios) {
      jobs.push({ variant, ratio, id: creativeId(project.slug, raw.id, variant.hash, ratio) });
    }
  }

  console.log(`テンプレート : ${raw.name} (${raw.id}@${raw.version})`);
  console.log(`プロジェクト : ${project.client} / ${project.campaign}`);
  console.log(`パターン数   : ${variants.length} × アスペクト比 ${options.ratios.length} = ${jobs.length} 本`);
  for (const [axis, counts] of Object.entries(balance)) {
    const detail = Object.entries(counts).map(([v, c]) => `${v}:${c}`).join('  ');
    console.log(`  軸 ${axis.padEnd(12)} ${detail}`);
  }

  if (options.dryRun) {
    console.log('\n--dry-run のため描画はしません。生成予定の creative_id:');
    for (const job of jobs) console.log(`  ${job.id}  ${JSON.stringify(job.variant.axes)}`);
    return { manifests: [], variants, balance, outDir: options.outDir, skipped: [] };
  }

  await mkdir(options.outDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  // フィルタグラフはほぼ単スレッドなので、1 コア余らせて本数を並べたほうが速い
  const concurrency = options.concurrency ?? Math.max(1, os.cpus().length - 1);
  const skipped: BatchResult['skipped'] = [];

  console.log(`\n描画開始（並列 ${concurrency}）`);
  const started = Date.now();

  const results = await pool(jobs, concurrency, async (job, index) => {
    try {
      const manifest = await renderOne(job, raw, project, projectDir, options, fonts, generatedAt);
      const warn = manifest.warnings.length > 0 ? `  ⚠ レイアウト警告 ${manifest.warnings.length} 件` : '';
      console.log(`  [${index + 1}/${jobs.length}] ${job.id}  ${manifest.deterministic_tags.duration_sec}s${warn}`);
      return manifest;
    } catch (error) {
      const reason = (error as Error).message;
      console.error(`  [${index + 1}/${jobs.length}] ${job.id}  失敗: ${reason.split('\n')[0]}`);
      skipped.push({ creativeId: job.id, reason });
      return null;
    }
  });

  const manifests = results.filter((m): m is Manifest => m !== null);

  await writeFile(
    path.join(options.outDir, 'batch.json'),
    JSON.stringify(
      {
        generated_at: generatedAt,
        project: { slug: project.slug, client: project.client, campaign: project.campaign },
        template: { id: raw.id, version: raw.version, name: raw.name },
        strategy: options.strategy,
        ratios: options.ratios,
        axis_balance: balance,
        creative_ids: manifests.map((m) => m.creative_id),
        skipped,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(path.join(options.outDir, 'creatives.csv'), manifestsToCsv(manifests), 'utf8');
  await writeFile(path.join(options.outDir, 'index.html'), renderReviewPage(manifests, project, raw), 'utf8');
  if (!options.keepWork) await rm(path.join(options.outDir, '.work'), { recursive: true, force: true });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n完了: ${manifests.length}/${jobs.length} 本  (${elapsed}s)`);
  if (skipped.length > 0) console.log(`失敗 ${skipped.length} 本 — batch.json の skipped を確認してください`);
  console.log(`出力先: ${options.outDir}`);
  console.log(`レビュー: ${path.join(options.outDir, 'index.html')} をブラウザで開く`);

  const violations = manifests.reduce((sum, m) => sum + m.warnings.length, 0);
  if (violations > 0) {
    const profile = options.safeAreaProfile ?? 'instream';
    console.log(`\n⚠ レイアウト警告が合計 ${violations} 件（profile=${profile}）`);
    for (const m of manifests) {
      for (const w of m.warnings) {
        const label = w.type === 'safe-area' ? 'セーフエリア' : 'コピー超過';
        console.log(`  ${m.creative_id}  [${label}] ${w.role ?? w.layerId}「${(w.text ?? '').replace(/\n/g, '／').slice(0, 18)}」 ${w.detail}`);
      }
    }
  }

  return { manifests, variants, balance, outDir: options.outDir, skipped };
}
