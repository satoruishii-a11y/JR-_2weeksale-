import type { Project, RatioKey } from './types.js';

/**
 * テンプレート JSON に埋め込める最小限の DSL を解決する。
 *
 *  1. 文字列補間  "${axis.hook}" / "${ratio}" / "${copy.headline.${axis.hook}}"
 *                 "${brand.primary}" / "${project.client}"
 *  2. 分岐        { "$switch": { "on": "axis:pacing", "cases": {...}, "default": ... } }
 *
 * 「テンプレート × 軸の組み合わせ × アスペクト比」を入力に、
 * 完全に具体化された 1 本ぶんの設計図を返すのが唯一の役割。
 * ここを純粋関数に保つことで、同じ入力からは常に同じ動画が出る（＝再現性）。
 */

export interface ResolveContext {
  axes: Record<string, string>;
  ratio: RatioKey;
  project: Project;
  /** $ref の解決先。通常はテンプレート JSON のルート */
  root?: unknown;
}

export class ResolveError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path})`);
    this.name = 'ResolveError';
  }
}

const MAX_INTERPOLATION_PASSES = 8;
/** 一番内側の ${...}（中に波括弧を含まないもの）だけを拾う */
const INNERMOST_TOKEN = /\$\{([^{}]+)\}/;

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function orientationOf(ratio: RatioKey): 'portrait' | 'landscape' | 'square' {
  if (ratio === '16x9') return 'landscape';
  if (ratio === '1x1') return 'square';
  return 'portrait';
}

function lookupToken(token: string, ctx: ResolveContext, path: string): unknown {
  const trimmed = token.trim();

  if (trimmed === 'ratio') return ctx.ratio;
  if (trimmed === 'orientation') return orientationOf(ctx.ratio);

  const [head, ...restParts] = trimmed.split('.');
  const rest = restParts.join('.');

  switch (head) {
    case 'axis': {
      if (!(rest in ctx.axes)) {
        throw new ResolveError(`未定義の軸を参照しています: ${rest}`, path);
      }
      return ctx.axes[rest];
    }
    case 'copy': {
      const value = getPath(ctx.project.copy, rest);
      if (value === undefined) {
        throw new ResolveError(`project.copy に ${rest} がありません`, path);
      }
      return value;
    }
    case 'brand': {
      const value = getPath(ctx.project.brand, rest);
      if (value === undefined) {
        throw new ResolveError(`project.brand に ${rest} がありません`, path);
      }
      return value;
    }
    case 'project': {
      const value = getPath(ctx.project, rest);
      if (value === undefined) {
        throw new ResolveError(`project に ${rest} がありません`, path);
      }
      return value;
    }
    default:
      throw new ResolveError(`未知の参照です: \${${trimmed}}`, path);
  }
}

function interpolate(input: string, ctx: ResolveContext, path: string, depth = 0): unknown {
  if (depth > MAX_INTERPOLATION_PASSES) {
    throw new ResolveError('文字列補間が循環しています', path);
  }
  let current = input;

  for (let pass = 0; pass < MAX_INTERPOLATION_PASSES; pass++) {
    const match = INNERMOST_TOKEN.exec(current);
    if (!match) return current;

    const [whole, token] = match;
    const value = lookupToken(token!, ctx, path);

    // 文字列全体がひとつのトークンなら型を保ったまま返す（数値・真偽値・配列を渡せる）
    if (whole === current) {
      return typeof value === 'string' ? interpolate(value, ctx, path, depth + 1) : value;
    }
    if (value !== null && typeof value === 'object') {
      throw new ResolveError(`\${${token}} はオブジェクトなので文字列に埋め込めません`, path);
    }
    current = current.replace(whole, String(value));
  }

  throw new ResolveError('文字列補間が循環しています', path);
}

function resolveSwitch(
  spec: Record<string, unknown>,
  ctx: ResolveContext,
  path: string,
  depth: number,
): unknown {
  const on = spec['on'];
  if (typeof on !== 'string') {
    throw new ResolveError('$switch には文字列の on が必要です', path);
  }

  let key: string;
  if (on === 'ratio') {
    key = ctx.ratio;
  } else if (on === 'orientation') {
    key = orientationOf(ctx.ratio);
  } else if (on.startsWith('axis:')) {
    const axisName = on.slice('axis:'.length);
    const value = ctx.axes[axisName];
    if (value === undefined) {
      throw new ResolveError(`未定義の軸を参照しています: ${axisName}`, path);
    }
    key = value;
  } else {
    throw new ResolveError(`$switch.on は "ratio" | "orientation" | "axis:<名前>" のみです: ${on}`, path);
  }

  const cases = spec['cases'];
  if (cases === null || typeof cases !== 'object') {
    throw new ResolveError('$switch には cases オブジェクトが必要です', path);
  }

  const table = cases as Record<string, unknown>;
  const branch = key in table ? table[key] : spec['default'];
  if (branch === undefined) {
    throw new ResolveError(`$switch に "${key}" の分岐も default もありません`, path);
  }
  return resolveNode(branch, ctx, `${path}.$switch(${key})`, depth);
}

const MAX_REF_DEPTH = 12;

/**
 * { "$ref": "defs.styles.headline", <上書きしたいキー> } の形。
 * テンプレート内の defs を使い回せるようにして、
 * スタイル定義がオーバーレイの数だけ複製されるのを防ぐ。
 */
function resolveRef(
  obj: Record<string, unknown>,
  ctx: ResolveContext,
  path: string,
  depth: number,
): unknown {
  const refPath = obj['$ref'];
  if (typeof refPath !== 'string') {
    throw new ResolveError('$ref には文字列のパスが必要です', path);
  }
  if (ctx.root === undefined) {
    throw new ResolveError('$ref を使うには解決コンテキストに root が必要です', path);
  }

  const target = getPath(ctx.root, refPath);
  if (target === undefined) {
    throw new ResolveError(`$ref の参照先が見つかりません: ${refPath}`, path);
  }

  const base = resolveNode(target, ctx, `${path}->${refPath}`, depth + 1);
  const overrides = Object.entries(obj).filter(([key]) => key !== '$ref');
  if (overrides.length === 0) return base;

  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    throw new ResolveError(`$ref の参照先がオブジェクトでないため上書きできません: ${refPath}`, path);
  }

  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of overrides) {
    merged[key] = resolveNode(value, ctx, `${path}.${key}`, depth + 1);
  }
  return merged;
}

/** テンプレート断片を再帰的に解決する */
export function resolveNode(node: unknown, ctx: ResolveContext, path = '$', depth = 0): unknown {
  if (depth > MAX_REF_DEPTH) {
    throw new ResolveError('$ref が循環しています', path);
  }
  if (typeof node === 'string') return interpolate(node, ctx, path);
  if (node === null || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item, i) => resolveNode(item, ctx, `${path}[${i}]`, depth));
  }

  const obj = node as Record<string, unknown>;

  if ('$ref' in obj) return resolveRef(obj, ctx, path, depth);

  if ('$switch' in obj) {
    const spec = obj['$switch'];
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new ResolveError('$switch の値はオブジェクトである必要があります', path);
    }
    return resolveSwitch(spec as Record<string, unknown>, ctx, path, depth);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = resolveNode(value, ctx, `${path}.${key}`, depth);
  }
  return out;
}
