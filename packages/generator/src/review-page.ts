import type { Manifest } from './manifest.js';
import type { Project, RawTemplate } from './types.js';

/**
 * 社内レビュー用の静的ページ。out/index.html をそのまま開けば
 * 全パターンを並べて確認でき、軸でフィルタもできる。
 * ダッシュボード（配信実績が乗る側）が出来るまでの繋ぎであり、
 * 「生成物を一覧で見る」役割はこのページが恒久的に持つ。
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function chip(label: string, value: string): string {
  return `<span class="chip"><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`;
}

export function renderReviewPage(manifests: Manifest[], project: Project, template: RawTemplate): string {
  const axisNames = Object.keys(template.axes).sort();

  const cards = manifests
    .map((m) => {
      const t = m.deterministic_tags;
      const axisAttrs = axisNames
        .map((a) => `data-axis-${escapeHtml(a)}="${escapeHtml(m.variant.axes[a] ?? '')}"`)
        .join(' ');

      const axisChips = Object.entries(m.variant.axes).map(([k, v]) => chip(k, v)).join('');
      const warn =
        m.warnings.length > 0
          ? `<p class="warn">⚠ レイアウト警告 ${m.warnings.length} 件: ${escapeHtml(
              m.warnings.map((w) => `${w.role ?? w.layerId} — ${w.detail}`).join(' / '),
            )}</p>`
          : '';

      return `
      <article class="card" data-ratio="${escapeHtml(t.aspect_ratio)}" ${axisAttrs}>
        <video src="${escapeHtml(m.output.video)}" poster="${escapeHtml(m.output.thumbnail ?? '')}"
               controls preload="none" playsinline muted></video>
        <div class="body">
          <h3>${escapeHtml(m.creative_id)}</h3>
          <div class="chips">${axisChips}</div>
          <dl>
            <div><dt>尺 / 比率</dt><dd>${t.duration_sec}s · ${escapeHtml(t.aspect_ratio)}</dd></div>
            <div><dt>テンポ</dt><dd>${escapeHtml(t.pacing)} (平均 ${t.avg_shot_length_sec}s/カット)</dd></div>
            <div><dt>見出し</dt><dd>${escapeHtml(t.headline_text ?? '—')}</dd></div>
            <div><dt>冒頭3秒の文字数</dt><dd>${t.first3s_text_chars}</dd></div>
            <div><dt>CTA</dt><dd>${t.cta_present ? `${escapeHtml(t.cta_text ?? '')} (${t.cta_first_shown_sec}s)` : 'なし'}</dd></div>
          </dl>
          ${warn}
        </div>
      </article>`;
    })
    .join('\n');

  const filters = axisNames
    .map((axis) => {
      const values = template.axes[axis]!.values;
      const options = ['<option value="">すべて</option>', ...values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)].join('');
      return `<label>${escapeHtml(axis)}<select data-filter="axis-${escapeHtml(axis)}">${options}</select></label>`;
    })
    .join('');

  const ratios = [...new Set(manifests.map((m) => m.deterministic_tags.aspect_ratio))];
  const ratioFilter = `<label>比率<select data-filter="ratio">${
    ['<option value="">すべて</option>', ...ratios.map((r) => `<option value="${r}">${r}</option>`)].join('')
  }</select></label>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(project.client)} / ${escapeHtml(project.campaign)} — クリエイティブレビュー</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#141414; --muted:#666; --line:#e3e3e3; --chip:#f2f2f2; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111; --fg:#eee; --muted:#999; --line:#2a2a2a; --chip:#232323; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font-family: system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  header { padding:24px 28px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
  h1 { margin:0 0 4px; font-size:1.15rem; }
  .meta { color:var(--muted); font-size:.85rem; }
  .filters { display:flex; gap:14px; flex-wrap:wrap; margin-top:14px; font-size:.82rem; }
  .filters label { display:flex; gap:6px; align-items:center; color:var(--muted); }
  select { font:inherit; padding:4px 8px; border-radius:6px; border:1px solid var(--line);
           background:var(--bg); color:var(--fg); }
  main { display:grid; gap:20px; padding:24px 28px;
         grid-template-columns: repeat(auto-fill, minmax(280px,1fr)); }
  .card { border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--bg); }
  .card[hidden] { display:none; }
  video { width:100%; display:block; background:#000; aspect-ratio:9/16; object-fit:contain; }
  .card[data-ratio="16x9"] video { aspect-ratio:16/9; }
  .card[data-ratio="1x1"] video { aspect-ratio:1/1; }
  .card[data-ratio="4x5"] video { aspect-ratio:4/5; }
  .body { padding:12px 14px 14px; }
  h3 { margin:0 0 8px; font-size:.78rem; font-weight:600; word-break:break-all; color:var(--muted); }
  .chips { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:10px; }
  .chip { background:var(--chip); border-radius:999px; padding:3px 9px; font-size:.72rem; }
  .chip b { font-weight:600; margin-right:5px; opacity:.6; }
  dl { margin:0; font-size:.78rem; }
  dl div { display:flex; gap:8px; padding:2px 0; }
  dt { color:var(--muted); min-width:8.5em; }
  dd { margin:0; }
  .warn { margin:10px 0 0; font-size:.74rem; color:#c2410c; }
  footer { padding:18px 28px 40px; color:var(--muted); font-size:.78rem; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(project.client)} / ${escapeHtml(project.campaign)}</h1>
  <p class="meta">${escapeHtml(template.name)} (${escapeHtml(template.id)}@${escapeHtml(template.version)}) · ${manifests.length} 本 · ${escapeHtml(manifests[0]?.generated_at ?? '')}</p>
  <div class="filters">${ratioFilter}${filters}</div>
</header>
<main>
${cards}
</main>
<footer>creatives.csv と manifests/*.json を分析パイプラインに取り込むと、実績と決定タグが creative_id で突き合わせられます。</footer>
<script>
  const selects = [...document.querySelectorAll('select[data-filter]')];
  const cards = [...document.querySelectorAll('.card')];
  const apply = () => {
    for (const card of cards) {
      card.hidden = selects.some((s) => s.value && card.dataset[toKey(s.dataset.filter)] !== s.value);
    }
  };
  function toKey(name) {
    return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  selects.forEach((s) => s.addEventListener('change', apply));
</script>
</body>
</html>
`;
}
