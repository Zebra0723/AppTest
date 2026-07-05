// Turn a raw audit into graded, categorized checks + an overall health score.
// Pure (no browser / network) so it is trivially testable.

const PASS = 'pass', WARN = 'warn', FAIL = 'fail', INFO = 'info';

const CATEGORY_WEIGHTS = {
  Availability: 30,
  JavaScript: 18,
  Network: 12,
  Layout: 16,
  Loading: 10,
  Responsive: 8,
  'Content & SEO': 4,
  Accessibility: 2,
};
const STATUS_PENALTY = { pass: 0, info: 0, warn: 0.5, fail: 1 };

function chk(category, label, status, detail, evidence = [], weight = 1) {
  return { category, label, status, detail, evidence, weight };
}

function isHydration(msg) {
  const low = String(msg).toLowerCase();
  return ['hydrat', 'did not match', 'text content does not match', 'minified react error',
    'cannot read properties of undefined', 'is not a function', 'chunkloaderror',
    'loading chunk'].some((n) => low.includes(n));
}

export function grade(audit) {
  const checks = [];
  const m = audit.metrics || {};
  const reports = audit.viewport_reports || [];
  const first = reports[0] || {};

  if (!audit.reachable) {
    checks.push(chk('Availability', 'Deployment reachable', FAIL,
      audit.error || 'The page could not be loaded at all.', [], 3));
    return assemble(audit, checks);
  }

  // Availability
  const code = m.http_status;
  if (code && code < 400) checks.push(chk('Availability', 'HTTP response', PASS, `Server returned ${code}.`));
  else if (code) checks.push(chk('Availability', 'HTTP response', FAIL, `Server returned ${code}.`, [], 3));
  else checks.push(chk('Availability', 'HTTP response', WARN, 'No main HTTP status captured (client-side redirect?).'));

  const load = m.load_ms || 0;
  if (load && load < 2500) checks.push(chk('Availability', 'Load time', PASS, `Loaded in ${load} ms.`));
  else if (load < 5000) checks.push(chk('Availability', 'Load time', WARN, `Loaded in ${load} ms — a little slow.`, [], 0.6));
  else if (load) checks.push(chk('Availability', 'Load time', FAIL, `Took ${load} ms to load — users will notice.`, [], 1.2));

  if (m.is_https) checks.push(chk('Availability', 'HTTPS', PASS, 'Served over HTTPS.'));
  else checks.push(chk('Availability', 'HTTPS', WARN, 'Not served over HTTPS.'));

  // Blank / crashed page
  const textLen = (first.content || {}).textLen || 0;
  const els = (first.content || {}).elements || 0;
  if (textLen < 8 && els < 12) {
    checks.push(chk('Availability', 'Rendered content', FAIL,
      'The page rendered essentially blank (no visible text/elements). Common with a build error, a crashed root component, or an unhandled exception during hydration.', [], 3));
  } else if (textLen < 40) {
    checks.push(chk('Availability', 'Rendered content', WARN, `Very little visible text (${textLen} chars).`));
  } else {
    checks.push(chk('Availability', 'Rendered content', PASS, `${textLen} chars of visible text rendered.`));
  }

  // JavaScript
  const perrs = audit.page_errors || [];
  if (perrs.length) checks.push(chk('JavaScript', 'Uncaught exceptions', FAIL, `${perrs.length} uncaught JavaScript exception(s) thrown.`, perrs.slice(0, 5), 2));
  else checks.push(chk('JavaScript', 'Uncaught exceptions', PASS, 'No uncaught JavaScript exceptions.'));

  const cerrs = (audit.console || {}).errors || [];
  const hyd = cerrs.filter(isHydration);
  if (hyd.length) checks.push(chk('JavaScript', 'Hydration / render errors', FAIL, `${hyd.length} hydration/render error(s) in the console.`, hyd.slice(0, 4), 1.5));
  if (cerrs.length) checks.push(chk('JavaScript', 'Console errors', cerrs.length <= 3 ? WARN : FAIL, `${cerrs.length} console error(s).`, cerrs.slice(0, 6), cerrs.length <= 3 ? 1 : 1.5));
  else checks.push(chk('JavaScript', 'Console errors', PASS, 'Console is clean.'));

  const cwarn = (audit.console || {}).warnings || [];
  if (cwarn.length) checks.push(chk('JavaScript', 'Console warnings', INFO, `${cwarn.length} console warning(s).`, cwarn.slice(0, 4)));

  // Network
  const failed = (audit.network || {}).failed || [];
  const bad = (audit.network || {}).bad_status || [];
  if (failed.length) checks.push(chk('Network', 'Failed requests', FAIL, `${failed.length} request(s) failed to load.`, failed.slice(0, 6).map((x) => `${x.url} (${x.reason})`), 1.5));
  else checks.push(chk('Network', 'Failed requests', PASS, 'No failed network requests.'));

  if (bad.length) {
    const server = bad.some((x) => x.status >= 500);
    checks.push(chk('Network', 'Broken resources', server ? FAIL : WARN, `${bad.length} resource(s) returned 4xx/5xx.`, bad.slice(0, 6).map((x) => `${x.status}  ${x.url}`), server ? 1.5 : 1));
  } else {
    checks.push(chk('Network', 'Broken resources', PASS, 'All resources returned OK.'));
  }

  // Layout
  const worst = reports.filter((r) => (r.overflow || {}).overflowPx > 4);
  if (worst.length) {
    const ev = worst.map((r) => {
      const offs = (r.overflow.offenders || []).slice(0, 3).map((o) => `<${o.tag} .${o.cls}>`).join(', ');
      return `${r.name}: +${r.overflow.overflowPx}px overflow. ${offs}`;
    });
    checks.push(chk('Layout', 'Horizontal overflow', worst.some((r) => r.name === 'Mobile') ? FAIL : WARN, 'Content overflows horizontally (causes sideways scroll / broken layout).', ev, 1.5));
  } else {
    checks.push(chk('Layout', 'Horizontal overflow', PASS, 'No horizontal overflow at any viewport.'));
  }

  let brokenImgs = [], missingAlt = 0;
  for (const r of reports) {
    if ((r.images || {}).broken && r.images.broken.length) brokenImgs = r.images.broken;
    missingAlt = Math.max(missingAlt, (r.images || {}).missingAlt || 0);
  }
  if (brokenImgs.length) checks.push(chk('Layout', 'Broken images', FAIL, `${brokenImgs.length} image(s) failed to render.`, brokenImgs.slice(0, 6), 1.2));
  else checks.push(chk('Layout', 'Broken images', PASS, 'All images rendered.'));

  if ((first.meta || {}).hasViewportMeta === false) checks.push(chk('Layout', 'Responsive meta tag', FAIL, 'Missing <meta name=viewport> — mobile rendering will be broken.', [], 1.2));
  else checks.push(chk('Layout', 'Responsive meta tag', PASS, 'Viewport meta tag present.'));

  // Loading
  let maxLoaders = 0, loaderSample = [];
  for (const r of reports) {
    const lv = (r.loaders || {}).visible || 0;
    if (lv > maxLoaders) { maxLoaders = lv; loaderSample = (r.loaders || {}).sample || []; }
  }
  if (maxLoaders > 0) checks.push(chk('Loading', 'Stuck loaders / skeletons', WARN, `${maxLoaders} loading indicator(s) still visible after the page settled — possible infinite spinner or failed data fetch.`, loaderSample.slice(0, 5), 1.2));
  else checks.push(chk('Loading', 'Stuck loaders / skeletons', PASS, 'No lingering spinners or skeletons after load.'));

  // Responsive
  if (reports.length >= 2) {
    const clean = reports.filter((r) => ((r.overflow || {}).overflowPx || 0) <= 4).length;
    if (clean === reports.length) checks.push(chk('Responsive', 'Multi-viewport layout', PASS, `Layout is clean across all ${reports.length} viewports tested.`));
    else checks.push(chk('Responsive', 'Multi-viewport layout', WARN, `${reports.length - clean}/${reports.length} viewport(s) show layout problems.`));
  }

  // Content & SEO
  const meta = first.meta || {};
  if (meta.title) checks.push(chk('Content & SEO', 'Page title', PASS, `“${meta.title.slice(0, 70)}”`));
  else checks.push(chk('Content & SEO', 'Page title', WARN, 'No <title> set.'));
  if (meta.description) checks.push(chk('Content & SEO', 'Meta description', PASS, 'Present.'));
  else checks.push(chk('Content & SEO', 'Meta description', INFO, 'No meta description.'));
  if (meta.hasFavicon === false) checks.push(chk('Content & SEO', 'Favicon', INFO, 'No favicon linked.'));
  if (meta.h1Count === 0) checks.push(chk('Content & SEO', 'Heading structure', WARN, 'No <h1> on the page.', [], 0.5));

  // Accessibility
  const uc = (first.a11y || {}).unlabeledControls || 0;
  const ui = (first.a11y || {}).unlabeledInputs || 0;
  if (missingAlt) checks.push(chk('Accessibility', 'Image alt text', WARN, `${missingAlt} image(s) missing alt text.`, [], 0.5));
  if (uc) checks.push(chk('Accessibility', 'Accessible control names', WARN, `${uc} button/link(s) have no accessible name.`, [], 0.5));
  if (ui) checks.push(chk('Accessibility', 'Form labels', WARN, `${ui} form input(s) have no label.`, [], 0.5));
  if (!missingAlt && !uc && !ui) checks.push(chk('Accessibility', 'Basic accessibility', PASS, 'No obvious accessibility gaps in the quick scan.'));

  return assemble(audit, checks);
}

function assemble(audit, checks) {
  const catPenalty = {}, catMax = {};
  for (const c of checks) {
    catPenalty[c.category] = (catPenalty[c.category] || 0) + STATUS_PENALTY[c.status] * c.weight;
    catMax[c.category] = (catMax[c.category] || 0) + c.weight;
  }

  let score = 100;
  const categoryScores = {};
  for (const [cat, weight] of Object.entries(CATEGORY_WEIGHTS)) {
    if (!catMax[cat]) { categoryScores[cat] = { score: 100, status: PASS, present: false }; continue; }
    const frac = Math.min(1, catPenalty[cat] / catMax[cat]);
    score -= frac * weight;
    const cscore = Math.round(100 * (1 - frac));
    const cstatus = cscore >= 85 ? PASS : cscore >= 55 ? WARN : FAIL;
    categoryScores[cat] = { score: cscore, status: cstatus, present: true };
  }

  score = audit.reachable ? Math.max(0, Math.round(score)) : 0;
  const fails = checks.filter((c) => c.status === FAIL).length;
  const warns = checks.filter((c) => c.status === WARN).length;

  let verdict, letter;
  if (score >= 90 && fails === 0) { verdict = 'Healthy'; letter = 'A'; }
  else if (score >= 75) { verdict = 'Minor issues'; letter = 'B'; }
  else if (score >= 55) { verdict = 'Needs attention'; letter = 'C'; }
  else if (score >= 35) { verdict = 'Serious problems'; letter = 'D'; }
  else { verdict = 'Critical'; letter = 'F'; }

  return { score, grade: letter, verdict, fails, warns, checks, category_scores: categoryScores };
}
