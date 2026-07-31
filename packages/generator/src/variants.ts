import { createHash } from 'node:crypto';
import type { RawTemplate, VariantCombo } from './types.js';

/**
 * 軸の組み合わせからバリアント（＝出し分けるパターン）を決める。
 *
 * 重要なのは `orthogonal`。単純な全数展開やランダム抽出だと、
 * 「速いテンポの動画はいつも黄色いテロップ」のような偏りが混入し、
 * 後段のタグ分析で "テンポが効いたのか色が効いたのか" を分離できなくなる。
 * 各軸の各値がなるべく均等に、かつ 2 軸の組み合わせも広く覆うように選ぶことで、
 * 少ない本数でも「どの要素が効いたか」を読める配分にする。
 */

export type Strategy =
  | { kind: 'grid'; limit?: number }
  | { kind: 'sample'; count: number }
  | { kind: 'orthogonal'; count: number };

export function parseStrategy(input: string): Strategy {
  const [name, rawCount] = input.split(':');
  const count = rawCount ? Number.parseInt(rawCount, 10) : NaN;

  switch (name) {
    case 'grid':
      return Number.isFinite(count) ? { kind: 'grid', limit: count } : { kind: 'grid' };
    case 'sample':
      if (!Number.isFinite(count) || count < 1) throw new Error('sample:<本数> の形式で指定してください');
      return { kind: 'sample', count };
    case 'orthogonal':
      if (!Number.isFinite(count) || count < 1) throw new Error('orthogonal:<本数> の形式で指定してください');
      return { kind: 'orthogonal', count };
    default:
      throw new Error(`未知の strategy: ${input}（grid / sample:N / orthogonal:N）`);
  }
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/** 軸の組み合わせから決まる安定ハッシュ。素材差し替えでは変わらない */
export function variantHash(template: RawTemplate, axes: Record<string, string>): string {
  const canonical = Object.keys(axes)
    .sort()
    .map((k) => `${k}=${axes[k]}`)
    .join('&');
  return sha1(`${template.id}@${template.version}|${canonical}`).slice(0, 6);
}

function cartesian(axisNames: string[], template: RawTemplate, cap: number): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];

  for (const name of axisNames) {
    const values = template.axes[name]!.values;
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [name]: value });
        if (next.length > cap) {
          throw new Error(
            `軸の組み合わせが ${cap} 件を超えました。軸を減らすか strategy を orthogonal:N にしてください`,
          );
        }
      }
    }
    combos = next;
  }
  return combos;
}

function comboKey(combo: Record<string, string>, axisNames: string[]): string {
  return axisNames.map((n) => `${n}=${combo[n]}`).join('&');
}

/** 決定論的な並べ替え。seed が同じなら常に同じ順序になる */
function stableShuffle<T>(items: T[], seed: string, keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = sha1(`${seed}|${keyOf(a)}`);
    const kb = sha1(`${seed}|${keyOf(b)}`);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

interface Coverage {
  singles: Set<string>;
  pairs: Set<string>;
}

function singlesOf(combo: Record<string, string>, axisNames: string[]): string[] {
  return axisNames.map((n) => `${n}=${combo[n]}`);
}

function pairsOf(combo: Record<string, string>, axisNames: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < axisNames.length; i++) {
    for (let j = i + 1; j < axisNames.length; j++) {
      const a = axisNames[i]!;
      const b = axisNames[j]!;
      out.push(`${a}=${combo[a]}|${b}=${combo[b]}`);
    }
  }
  return out;
}

function gain(combo: Record<string, string>, axisNames: string[], cov: Coverage): number {
  let score = 0;
  for (const s of singlesOf(combo, axisNames)) if (!cov.singles.has(s)) score += 100;
  for (const p of pairsOf(combo, axisNames)) if (!cov.pairs.has(p)) score += 10;
  return score;
}

function commit(combo: Record<string, string>, axisNames: string[], cov: Coverage): void {
  for (const s of singlesOf(combo, axisNames)) cov.singles.add(s);
  for (const p of pairsOf(combo, axisNames)) cov.pairs.add(p);
}

/**
 * 貪欲法で被覆度の高い組み合わせから順に取る。
 * すべて覆い終えたら被覆表をリセットして次の周回に入るので、
 * 本数を増やしても各軸の値が均等に出続ける。
 */
function selectOrthogonal(
  all: Record<string, string>[],
  axisNames: string[],
  count: number,
  seed: string,
): Record<string, string>[] {
  const pool = stableShuffle(all, seed, (c) => comboKey(c, axisNames));
  const used = new Set<string>();
  const selected: Record<string, string>[] = [];
  const cov: Coverage = { singles: new Set(), pairs: new Set() };

  while (selected.length < count) {
    const remaining = pool.filter((c) => !used.has(comboKey(c, axisNames)));
    if (remaining.length === 0) break;

    let best = remaining[0]!;
    let bestScore = gain(best, axisNames, cov);
    for (const candidate of remaining) {
      const score = gain(candidate, axisNames, cov);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    // もう新しく覆えるものが無い＝1 周した。表を空にして次の周回へ
    if (bestScore === 0 && cov.singles.size > 0) {
      cov.singles.clear();
      cov.pairs.clear();
      continue;
    }

    used.add(comboKey(best, axisNames));
    commit(best, axisNames, cov);
    selected.push(best);
  }

  return selected;
}

export function expandVariants(template: RawTemplate, strategy: Strategy, seed = ''): VariantCombo[] {
  const axisNames = Object.keys(template.axes).sort();

  // 軸が無いテンプレートは 1 パターンだけ
  if (axisNames.length === 0) {
    return [{ axes: {}, hash: variantHash(template, {}) }];
  }

  const all = cartesian(axisNames, template, 20_000);
  const effectiveSeed = seed || `${template.id}@${template.version}`;

  let chosen: Record<string, string>[];
  switch (strategy.kind) {
    case 'grid':
      chosen = strategy.limit ? all.slice(0, strategy.limit) : all;
      break;
    case 'sample':
      chosen = stableShuffle(all, effectiveSeed, (c) => comboKey(c, axisNames)).slice(0, strategy.count);
      break;
    case 'orthogonal':
      chosen = selectOrthogonal(all, axisNames, Math.min(strategy.count, all.length), effectiveSeed);
      break;
  }

  return chosen.map((axes) => ({ axes, hash: variantHash(template, axes) }));
}

/** 選ばれたバリアント群で各軸の値が何本ずつ出ているか（配分の偏りチェック用） */
export function axisBalance(variants: VariantCombo[]): Record<string, Record<string, number>> {
  const table: Record<string, Record<string, number>> = {};
  for (const v of variants) {
    for (const [axis, value] of Object.entries(v.axes)) {
      table[axis] ??= {};
      table[axis]![value] = (table[axis]![value] ?? 0) + 1;
    }
  }
  return table;
}

export function creativeId(
  projectSlug: string,
  templateId: string,
  hash: string,
  ratio: string,
): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${safe(projectSlug)}_${safe(templateId)}_${hash}_${ratio}`;
}
