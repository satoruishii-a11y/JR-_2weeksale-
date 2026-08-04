#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLayouts, loadProject, loadTemplate, renderBatch } from './render.js';
import { RATIOS, SAFE_AREA_PROFILE_NAMES, type RatioKey, type SafeAreaProfile } from './types.js';
import { axisBalance, expandVariants, parseStrategy } from './variants.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = path.join(PACKAGE_ROOT, 'templates');

interface Args {
  command: string;
  flags: Record<string, string>;
  bools: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};
  const bools = new Set<string>();

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      bools.add(name);
    } else {
      flags[name] = next;
      i++;
    }
  }

  return { command, flags, bools };
}

function resolveTemplatePath(value: string): string {
  if (value.endsWith('.json') || value.includes('/') || value.includes('\\')) {
    return path.resolve(value);
  }
  return path.join(TEMPLATE_DIR, `${value}.json`);
}

function parseRatios(value: string | undefined): RatioKey[] {
  // YouTube広告の主戦場はインストリーム（16:9）。9x16 は Shorts 面向けの追加なので、
  // 何も指定しなければ 16x9 を出す
  if (!value) return ['16x9'];
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (!(RATIOS as readonly string[]).includes(part)) {
      throw new Error(`未対応のアスペクト比: ${part}（${RATIOS.join(' / ')}）`);
    }
  }
  return parts as RatioKey[];
}

const HELP = `
creative-gen — 静止画から YouTube 広告クリエイティブを量産する

使い方:
  creative-gen render   --project <dir> --template <id|path> [options]   動画を書き出す
  creative-gen layout   --project <dir> --template <id|path> [options]   組版だけ検証（ffmpeg を回さない・数秒）
  creative-gen plan     --project <dir> --template <id|path> [options]   生成予定のパターン配分を見る
  creative-gen validate --project <dir> --template <id|path>             素材と設定の存在チェック
  creative-gen templates                                                 テンプレート一覧

options:
  --out <dir>           出力先（既定: <project>/out）
  --strategy <spec>     orthogonal:N | sample:N | grid[:N]（既定: orthogonal:6）
                        orthogonal は各軸の値が均等に出るよう選ぶ。分析で要素を切り分けたいならこれ
  --ratios <list>       16x9,9x16,1x1,4x5 のカンマ区切り（既定: 16x9＝インストリーム）
  --seed <string>       バリアント選択の乱数種。同じ種なら常に同じ組み合わせ
  --safe-area <name>    テキストのはみ出し判定に使う配信面（${SAFE_AREA_PROFILE_NAMES.join(' / ')}、既定: instream）
  --preset <name>       x264 プリセット（既定: medium。下書きは veryfast が速い）
  --crf <n>             画質。小さいほど高画質・大容量（既定: 20）
  --concurrency <n>     並列描画数（既定: 論理コア数 - 1）
  --contact-sheet       冒頭確認用のコンタクトシートも書き出す
  --keep-work           中間 PNG を残す（レイアウト調整時に便利）
  --dry-run             描画せず生成予定の一覧だけ出す

例:
  # インストリーム（16:9）を6パターン。YouTube広告の主戦場はここ
  creative-gen render --project projects/kyoto-koyo --template editorial-15s \\
    --strategy orthogonal:6

  # Shorts 面にも出すなら 9x16 を足し、判定を shorts に切り替える
  # （右のアクションバーぶん中央寄せの使用可能幅が狭くなるので、コピーの短縮が必要）
  creative-gen render --project projects/kyoto-koyo --template editorial-15s \\
    --strategy orthogonal:6 --ratios 16x9,9x16 --safe-area shorts
`;

async function main(): Promise<void> {
  const { command, flags, bools } = parseArgs(process.argv.slice(2));

  if (command === 'help' || bools.has('help')) {
    console.log(HELP.trim());
    return;
  }

  if (command === 'templates') {
    if (!existsSync(TEMPLATE_DIR)) {
      console.log('templates ディレクトリがありません');
      return;
    }
    const files = (await readdir(TEMPLATE_DIR)).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const template = await loadTemplate(path.join(TEMPLATE_DIR, file));
      const axes = Object.entries(template.axes)
        .map(([name, spec]) => `${name}(${spec.values.length})`)
        .join(' ');
      const combos = Object.values(template.axes).reduce((acc, spec) => acc * spec.values.length, 1);
      console.log(`${template.id.padEnd(20)} ${template.name}`);
      console.log(`${''.padEnd(20)} 軸: ${axes || 'なし'} → 全 ${combos} パターン`);
    }
    return;
  }

  const projectDir = flags['project'];
  const templateRef = flags['template'];
  if (!projectDir || !templateRef) {
    console.error('--project と --template は必須です\n');
    console.log(HELP.trim());
    process.exitCode = 1;
    return;
  }

  const templateFile = resolveTemplatePath(templateRef);

  if (command === 'validate') {
    const project = await loadProject(path.resolve(projectDir));
    const template = await loadTemplate(templateFile);
    console.log(`✓ project.json  ${project.client} / ${project.campaign}  素材 ${project.assets.length} 点`);
    console.log(`✓ template      ${template.name} (${template.id}@${template.version})`);
    let failed = false;

    // ${ratio} を含むパスは、実際に出す比率のぶんだけ確認する（--ratios で指定）
    const checkRatios = parseRatios(flags['ratios']);
    const missingAssets: string[] = [];
    for (const asset of project.assets) {
      const candidates = asset.file.includes('${ratio}')
        ? checkRatios.map((r) => asset.file.replaceAll('${ratio}', r))
        : [asset.file];
      for (const candidate of candidates) {
        if (!existsSync(path.resolve(projectDir, candidate))) missingAssets.push(candidate);
      }
    }
    if (missingAssets.length > 0) {
      console.error(`✗ 見つからない素材: ${missingAssets.join(', ')}`);
      failed = true;
    } else {
      console.log(`✓ 素材ファイル ${project.assets.length} 点はすべて存在します`);
    }

    const missingCopy = template.requiredCopy.filter((keyPath) => {
      let cursor: unknown = project.copy;
      for (const key of keyPath.split('.')) {
        if (cursor === null || typeof cursor !== 'object') return true;
        cursor = (cursor as Record<string, unknown>)[key];
      }
      return typeof cursor !== 'string' || cursor.trim() === '';
    });
    if (missingCopy.length > 0) {
      console.error(`✗ project.copy に足りないコピー: ${missingCopy.join(', ')}`);
      failed = true;
    } else if (template.requiredCopy.length > 0) {
      console.log(`✓ 必要なコピー ${template.requiredCopy.length} 件はすべて揃っています`);
    }

    if (failed) process.exitCode = 1;
    return;
  }

  if (command !== 'render' && command !== 'plan' && command !== 'layout') {
    console.error(`未知のコマンド: ${command}\n`);
    console.log(HELP.trim());
    process.exitCode = 1;
    return;
  }

  const strategy = parseStrategy(flags['strategy'] ?? 'orthogonal:6');
  const ratios = parseRatios(flags['ratios']);
  const outDir = path.resolve(flags['out'] ?? path.join(projectDir, 'out'));

  if (command === 'plan') {
    const template = await loadTemplate(templateFile);
    const variants = expandVariants(template, strategy, flags['seed']);
    console.log(`${template.name}: ${variants.length} パターン × ${ratios.length} 比率 = ${variants.length * ratios.length} 本\n`);
    for (const [axis, counts] of Object.entries(axisBalance(variants))) {
      console.log(`軸 ${axis}`);
      for (const [value, count] of Object.entries(counts)) {
        console.log(`   ${value.padEnd(16)} ${'■'.repeat(count)} ${count}`);
      }
    }
    console.log('\nパターン一覧:');
    for (const v of variants) {
      console.log(`  ${v.hash}  ${Object.entries(v.axes).map(([k, x]) => `${k}=${x}`).join('  ')}`);
    }
    return;
  }

  const safeArea = (flags['safe-area'] ?? 'instream') as SafeAreaProfile;
  if (!SAFE_AREA_PROFILE_NAMES.includes(safeArea)) {
    throw new Error(`未知の --safe-area: ${safeArea}（${SAFE_AREA_PROFILE_NAMES.join(' / ')}）`);
  }

  if (command === 'layout') {
    const reports = await checkLayouts({
      projectDir: path.resolve(projectDir),
      templateFile,
      outDir,
      strategy,
      ratios,
      seed: flags['seed'],
      safeAreaProfile: safeArea,
    });

    let violations = 0;
    for (const report of reports) {
      const mark = report.warnings.length === 0 ? '✓' : '✗';
      console.log(`${mark} ${report.creativeId}  ${report.duration}s`);
      for (const text of report.texts) {
        console.log(`    ${text.role.padEnd(9)} ${text.sizePct}%  ${text.lines.map((l) => `「${l}」`).join('')}`);
      }
      for (const warning of report.warnings) {
        violations++;
        const label = warning.type === 'safe-area' ? 'セーフエリア' : 'コピー超過';
        console.log(`    ⚠ [${label}] ${warning.role ?? warning.layerId}  ${warning.detail}`);
      }
    }
    console.log(
      violations === 0
        ? `\n✓ レイアウト警告なし（profile=${safeArea}、${reports.length} 本ぶん検証）`
        : `\n⚠ レイアウト警告 ${violations} 件（profile=${safeArea}）`,
    );
    return;
  }

  await renderBatch({
    projectDir: path.resolve(projectDir),
    templateFile,
    outDir,
    strategy,
    ratios,
    seed: flags['seed'],
    safeAreaProfile: safeArea,
    preset: flags['preset'],
    crf: flags['crf'] ? Number.parseInt(flags['crf'], 10) : undefined,
    dryRun: bools.has('dry-run'),
    concurrency: flags['concurrency'] ? Number.parseInt(flags['concurrency'], 10) : undefined,
    contactSheet: bools.has('contact-sheet'),
    keepWork: bools.has('keep-work'),
  });
}

main().catch((error: unknown) => {
  console.error(`\nエラー: ${(error as Error).message}`);
  process.exitCode = 1;
});
