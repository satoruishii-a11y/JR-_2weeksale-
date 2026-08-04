import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * アスペクト比プリセット
 * ------------------------------------------------------------------ */

export const RATIOS = ['9x16', '16x9', '1x1', '4x5'] as const;
export const RatioKeySchema = z.enum(RATIOS);
export type RatioKey = z.infer<typeof RatioKeySchema>;

export const RATIO_PRESETS: Record<RatioKey, { width: number; height: number }> = {
  '9x16': { width: 1080, height: 1920 },
  '16x9': { width: 1920, height: 1080 },
  '1x1': { width: 1080, height: 1080 },
  '4x5': { width: 1080, height: 1350 },
};

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * UI に隠れる可能性がある領域（キャンバスに対する %）。踏んだテキストは警告を出す。
 *
 * 配信面によって塞がれる場所が違うので profile で切り替える。
 * とくに Shorts は右のアクションバーと下のタイトル帯が広く、
 * これを instream と同じ基準で見ると中央寄せのテロップが常に警告になってしまう。
 */
export const SAFE_AREA_PROFILES = {
  /** スキッパブル / バンパー インストリーム。プレイヤーの操作系だけ避ける */
  instream: {
    '9x16': { top: 8, right: 8, bottom: 16, left: 8 },
    '16x9': { top: 5, right: 5, bottom: 10, left: 5 },
    '1x1': { top: 6, right: 6, bottom: 12, left: 6 },
    '4x5': { top: 6, right: 6, bottom: 14, left: 6 },
  },
  /** Shorts フィード。右のアクションバーと下部のタイトル・CTA 帯を避ける */
  shorts: {
    '9x16': { top: 9, right: 17, bottom: 22, left: 5 },
    '16x9': { top: 5, right: 5, bottom: 10, left: 5 },
    '1x1': { top: 6, right: 12, bottom: 16, left: 6 },
    '4x5': { top: 6, right: 14, bottom: 18, left: 6 },
  },
} as const satisfies Record<string, Record<RatioKey, Insets>>;

export type SafeAreaProfile = keyof typeof SAFE_AREA_PROFILES;
export const SAFE_AREA_PROFILE_NAMES = Object.keys(SAFE_AREA_PROFILES) as SafeAreaProfile[];

/* ------------------------------------------------------------------ *
 * モーション / トランジション
 * ------------------------------------------------------------------ */

export const MotionSchema = z.enum([
  'still',
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
]);
export type Motion = z.infer<typeof MotionSchema>;

export const TransitionSchema = z.enum([
  'cut',
  'fade',
  'dissolve',
  'wipeleft',
  'wiperight',
  'slideup',
  'slidedown',
  'smoothleft',
  'smoothright',
  'circleopen',
  'fadeblack',
  'fadewhite',
]);
export type Transition = z.infer<typeof TransitionSchema>;

/* ------------------------------------------------------------------ *
 * オーバーレイ
 * ------------------------------------------------------------------ */

export const AnchorSchema = z.enum([
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);
export type Anchor = z.infer<typeof AnchorSchema>;

export const OverlayAnimSchema = z.enum([
  'none',
  'fade',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
]);
export type OverlayAnim = z.infer<typeof OverlayAnimSchema>;

export const TextStyleSchema = z.object({
  /** project.fonts に登録したキー。未指定なら default */
  font: z.string().default('default'),
  /** キャンバス高に対する文字サイズ % */
  sizePct: z.number().positive(),
  /**
   * maxLines に収まらないとき、ここまで自動で縮める（既定は sizePct の 62%）。
   * 月ごとにコピーの文字数が変わってもレイアウトが崩れないようにするための逃げ道。
   */
  minSizePct: z.number().positive().optional(),
  color: z.string().default('#FFFFFF'),
  strokeColor: z.string().optional(),
  /** フォントサイズに対する縁取り幅 % */
  strokeWidthPct: z.number().min(0).default(0),
  lineHeight: z.number().positive().default(1.32),
  letterSpacingEm: z.number().default(0.02),
  align: z.enum(['left', 'center', 'right']).default('center'),
  /**
   * vertical は縦書き。列は右から左へ進み、長音・括弧・英数は 90 度回転させる。
   * 和文の広告らしさが一番出る指定なので、大見出しに使う。
   */
  writingMode: z.enum(['horizontal', 'vertical']).default('horizontal'),
  /**
   * 折り返しの決め方。
   *  kinsoku — 幅いっぱいまで詰めて、行頭・行末に置けない文字だけ調整する（既定）
   *  phrase  — BudouX で文節の境界を出し、そこを優先して折り返す。
   *            「京都の紅葉2日／間3万円台」のような語中での分断を防げるので、
   *            コピーが毎月変わる見出し・本文はこちらが安全。
   */
  breakStrategy: z.enum(['kinsoku', 'phrase']).default('kinsoku'),
  /** テキスト背面の帯 */
  band: z
    .object({
      color: z.string(),
      paddingXEm: z.number().default(0.6),
      paddingYEm: z.number().default(0.28),
      radiusEm: z.number().default(0.12),
      /** 行ごとに帯を分けるか（見出しの座布団は行ごとが自然） */
      perLine: z.boolean().default(true),
    })
    .optional(),
  shadow: z
    .object({
      color: z.string().default('rgba(0,0,0,0.55)'),
      blurEm: z.number().default(0.18),
      offsetXEm: z.number().default(0),
      offsetYEm: z.number().default(0.06),
    })
    .optional(),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

const OverlayBase = {
  id: z.string().optional(),
  /** シーン先頭からの相対秒（template.overlays の場合は動画先頭からの絶対秒） */
  start: z.number().min(0).default(0),
  /** 未指定ならシーン終端（template.overlays なら動画終端）まで */
  end: z.number().positive().optional(),
  anchor: AnchorSchema.default('center'),
  /** anchor 位置からのオフセット（キャンバス幅/高に対する %） */
  xPct: z.number().default(0),
  yPct: z.number().default(0),
  anim: OverlayAnimSchema.default('fade'),
  animDuration: z.number().min(0).default(0.3),
  outAnim: OverlayAnimSchema.optional(),
  outDuration: z.number().min(0).default(0.25),
  /** セーフエリア警告を無視する（背景装飾など） */
  ignoreSafeArea: z.boolean().default(false),
};

export const TextOverlaySchema = z.object({
  ...OverlayBase,
  kind: z.literal('text'),
  text: z.string(),
  /** 折り返し幅（キャンバス幅に対する %）。帯の余白と縁取りを含めた外寸 */
  maxWidthPct: z.number().positive().default(84),
  /** 縦書きのときの折り返し高さ（キャンバス高に対する %） */
  maxHeightPct: z.number().positive().default(60),
  /** 指定するとこの行数（縦書きなら列数）に収まるまで自動で文字を縮める */
  maxLines: z.number().int().positive().optional(),
  style: TextStyleSchema,
  /** 分析用の意味ラベル。決定タグにそのまま入る */
  role: z.enum(['headline', 'sub', 'price', 'cta', 'note', 'brand']).default('note'),
});
export type TextOverlay = z.infer<typeof TextOverlaySchema>;

export const ImageOverlaySchema = z.object({
  ...OverlayBase,
  kind: z.literal('image'),
  /** project ディレクトリからの相対パス */
  file: z.string(),
  widthPct: z.number().positive(),
  opacity: z.number().min(0).max(1).default(1),
  role: z.enum(['logo', 'badge', 'sticker']).default('sticker'),
});
export type ImageOverlay = z.infer<typeof ImageOverlaySchema>;

export const BandOverlaySchema = z.object({
  ...OverlayBase,
  kind: z.literal('band'),
  widthPct: z.number().positive(),
  heightPct: z.number().positive(),
  color: z.string(),
  radiusPct: z.number().min(0).default(0),
  opacity: z.number().min(0).max(1).default(1),
});
export type BandOverlay = z.infer<typeof BandOverlaySchema>;

export const ScrimOverlaySchema = z.object({
  ...OverlayBase,
  kind: z.literal('scrim'),
  /** テキスト可読性のためのグラデーション */
  side: z.enum(['bottom', 'top', 'full']).default('bottom'),
  heightPct: z.number().positive().default(45),
  color: z.string().default('#000000'),
  strength: z.number().min(0).max(1).default(0.65),
});
export type ScrimOverlay = z.infer<typeof ScrimOverlaySchema>;

export const OverlaySchema = z.discriminatedUnion('kind', [
  TextOverlaySchema,
  ImageOverlaySchema,
  BandOverlaySchema,
  ScrimOverlaySchema,
]);
export type Overlay = z.infer<typeof OverlaySchema>;

/* ------------------------------------------------------------------ *
 * シーン / テンプレート（解決済み）
 * ------------------------------------------------------------------ */

export const SceneSchema = z.object({
  id: z.string().optional(),
  /** project.assets の id */
  asset: z.string(),
  duration: z.number().positive(),
  motion: MotionSchema.default('still'),
  /** 0=控えめ 1=強め。ズーム量・パン量に掛かる */
  motionIntensity: z.number().min(0).max(1).default(0.5),
  /**
   * 動きの加減速。zoompan は既定だと等速で、機械的に見える。
   * 実際の広告は寄り始めが速く終わりで減速するので ease-out を既定にした。
   */
  motionEase: z.enum(['linear', 'ease-out', 'ease-in-out']).default('ease-out'),
  /** 直前のシーンからの繋ぎ。scenes[0] では無視される */
  transitionIn: TransitionSchema.default('cut'),
  transitionDuration: z.number().min(0).default(0.35),
  grade: z
    .object({
      brightness: z.number().min(-1).max(1).default(0),
      contrast: z.number().min(0).max(3).default(1),
      saturation: z.number().min(0).max(3).default(1),
      blurPx: z.number().min(0).default(0),
    })
    .optional(),
  overlays: z.array(OverlaySchema).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ResolvedTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  fps: z.number().int().positive().default(30),
  /** 冒頭フック分類。決定タグとして記録するだけで描画には使わない */
  hookType: z.string().optional(),
  audio: z
    .object({
      bgm: z.string().optional(),
      /**
       * BGM の目標ラウドネス（LUFS）。指定すると音源を実測して静的ゲインを掛けるので、
       * どの音源に差し替えても仕上がりの音量が揃う。volume は無視される。
       * YouTube は概ね -14 LUFS に正規化するため、音楽のみの広告は -16 前後が無難。
       */
      targetLufs: z.number().min(-40).max(-6).optional(),
      /**
       * BGM のテンポ。指定すると scenes[].duration に {"$beats": 4} と書けるようになり、
       * カットの切り替わりが曲の拍に乗る。拍と無関係に切ると編集が締まらない。
       */
      bpm: z.number().min(40).max(240).optional(),
      volume: z.number().min(0).max(2).default(0.22),
      fadeIn: z.number().min(0).default(0.6),
      fadeOut: z.number().min(0).default(1.0),
    })
    .default({ volume: 0.22, fadeIn: 0.6, fadeOut: 1.0 }),
  scenes: z.array(SceneSchema).min(1),
  /** 動画全体に載るオーバーレイ（ロゴ・常時CTAなど）。時間は絶対秒 */
  overlays: z.array(OverlaySchema).default([]),
});
export type ResolvedTemplate = z.infer<typeof ResolvedTemplateSchema>;

/* ------------------------------------------------------------------ *
 * 生テンプレート（$switch / ${} を含む状態）
 * ------------------------------------------------------------------ */

export const RawTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    axes: z
      .record(
        z.object({
          description: z.string().optional(),
          values: z.array(z.string()).min(1),
        }),
      )
      .default({}),
    /**
     * このテンプレートが必要とする project.copy のパス。
     * 案件を差し替えたときのコピー漏れを validate で先に潰すための宣言。
     */
    requiredCopy: z.array(z.string()).default([]),
    scenes: z.array(z.unknown()).min(1),
  })
  .passthrough();
export type RawTemplate = z.infer<typeof RawTemplateSchema>;

/* ------------------------------------------------------------------ *
 * プロジェクト（素材＋コピー）
 * ------------------------------------------------------------------ */

export const ProjectSchema = z.object({
  /** creative_id に入る短い識別子。英数字とハイフンのみ */
  slug: z.string().regex(/^[a-z0-9-]+$/),
  client: z.string(),
  campaign: z.string(),
  brand: z
    .object({
      primary: z.string().default('#111111'),
      accent: z.string().default('#FFD400'),
      textOnPrimary: z.string().default('#FFFFFF'),
      logo: z.string().optional(),
    })
    .default({ primary: '#111111', accent: '#FFD400', textOnPrimary: '#FFFFFF' }),
  fonts: z.record(z.array(z.string())).default({}),
  assets: z
    .array(
      z.object({
        id: z.string(),
        file: z.string(),
        role: z.string().default('hero'),
        /** 被写体メモ。決定タグに入り、後段の分析軸になる */
        subject: z.string().optional(),
      }),
    )
    .min(1),
  /** ネストしたコピー辞書。${copy.headline.price} で参照する */
  copy: z.record(z.unknown()).default({}),
  bgm: z.string().optional(),
  /** 誇大表現チェック等に使う注意書き */
  legalNote: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/* ------------------------------------------------------------------ *
 * バリアント
 * ------------------------------------------------------------------ */

export interface VariantCombo {
  /** 軸名 -> 選択値 */
  axes: Record<string, string>;
  /** 軸の組み合わせから決まる 6 桁ハッシュ */
  hash: string;
}

export interface RenderTarget {
  ratio: RatioKey;
  width: number;
  height: number;
  fps: number;
}
