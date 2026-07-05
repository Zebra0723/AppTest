// Drive Chromium against a deployment and collect a raw audit (the checks live
// in lib/pageAudit.js; grading lives in lib/grade.js).
import { launchBrowser } from './browser.js';
import { pageAudit, featureProbe } from './pageAudit.js';
import { performLogin } from './login.js';

const DEFAULT_VIEWPORTS = [
  { name: 'Desktop', width: 1440, height: 900 },
  { name: 'Mobile', width: 390, height: 844 },
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36 VercelCheckBot/1.0';

export async function runAudit({ url, features = [], viewports = DEFAULT_VIEWPORTS, waitExtraMs = 2500, auth = null }) {
  const result = {
    url, ok: false, reachable: false, metrics: {},
    console: { errors: [], warnings: [] }, page_errors: [],
    network: { failed: [], bad_status: [] },
    viewport_reports: [], screenshots: [], features: [], page_text: '', error: null,
    login: null,
  };

  const cErr = [], cWarn = [], pErr = [], failed = [], bad = [];
  const seen = new Set();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: viewports[0].width, height: viewports[0].height });

    // Optional: sign in first, so the audit runs against the authenticated app.
    // Done before attaching the audit listeners so login-page console/network
    // noise never leaks into the report.
    if (auth && auth.password && (auth.username || auth.userSelector)) {
      try {
        result.login = await performLogin(page, { ...auth, targetUrl: url });
      } catch (e) {
        result.login = { attempted: true, success: false, detail: `Login error: ${e && e.message ? e.message : e}` };
      }
    }

    page.on('console', (msg) => {
      const t = msg.type(), txt = (msg.text() || '').slice(0, 500);
      const key = t + '|' + txt;
      if (seen.has(key)) return;
      seen.add(key);
      if (t === 'error') cErr.push(txt);
      else if (t === 'warning' || t === 'warn') cWarn.push(txt);
    });
    page.on('pageerror', (err) => pErr.push(String(err && err.message ? err.message : err).slice(0, 500)));
    page.on('requestfailed', (req) => {
      const reason = (req.failure() && req.failure().errorText) || '';
      if (reason.includes('ERR_ABORTED')) return;
      failed.push({ url: req.url().slice(0, 200), reason: reason.slice(0, 120) });
    });
    page.on('response', (res) => {
      const st = res.status();
      if (st >= 400) bad.push({ url: res.url().slice(0, 200), status: st });
    });

    // Navigate
    const t0 = Date.now();
    let status = null, headers = {};
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    result.reachable = true;
    if (response) {
      status = response.status();
      try { headers = response.headers() || {}; } catch (e) { headers = {}; }
    }
    const dclMs = Date.now() - t0;
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 8000 }).catch(() => {});
    const loadMs = Date.now() - t0;
    await sleep(waitExtraMs); // let SPA hydration / client fetches settle
    const settledMs = Date.now() - t0;

    result.metrics = {
      http_status: status,
      dom_content_loaded_ms: dclMs,
      load_ms: loadMs,
      settled_ms: settledMs,
      final_url: page.url(),
      is_https: page.url().startsWith('https://'),
      security_headers: {
        'content-security-policy': !!headers['content-security-policy'],
        'strict-transport-security': !!headers['strict-transport-security'],
        'x-frame-options': !!headers['x-frame-options'],
        'x-content-type-options': !!headers['x-content-type-options'],
      },
      server: headers['server'] || '',
      x_vercel_id: headers['x-vercel-id'] || '',
    };

    // Per-viewport audit + screenshots
    let firstAudit = null;
    for (let i = 0; i < viewports.length; i++) {
      const vp = viewports[i];
      await page.setViewport({ width: vp.width, height: vp.height });
      await sleep(500); // allow reflow / responsive JS
      let a;
      try { a = await page.evaluate(pageAudit); } catch (e) { a = { error: String(e).slice(0, 200) }; }
      a.name = vp.name;
      try {
        const b64 = await page.screenshot({ encoding: 'base64', fullPage: i === 0, type: 'png' });
        result.screenshots.push({ name: vp.name, b64, width: vp.width, height: vp.height });
      } catch (e) { /* screenshot optional */ }
      result.viewport_reports.push(a);
      if (!firstAudit) firstAudit = a;
    }

    // Feature heuristics (desktop viewport)
    await page.setViewport({ width: viewports[0].width, height: viewports[0].height });
    for (const raw of features) {
      const feat = String(raw).trim();
      if (!feat) continue;
      let probe;
      try { probe = await page.evaluate(featureProbe, feat); } catch (e) { probe = { matched: 0, total: 0 }; }
      const total = probe.total || 0, matched = probe.matched || 0;
      const ratio = total ? matched / total : 0;
      const status2 = ratio >= 0.75 ? 'pass' : ratio >= 0.34 ? 'warn' : 'fail';
      result.features.push({ feature: feat, status: status2, matched_terms: matched, total_terms: total, note: featureNote(status2, matched, total) });
    }

    result.page_text = (firstAudit && firstAudit.content && firstAudit.content.sample) || '';
  } catch (e) {
    if (!result.reachable) result.error = `Navigation failed: ${e && e.message ? e.message : e}`;
    else result.error = `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* noop */ } }
  }

  result.console.errors = cErr.slice(0, 30);
  result.console.warnings = cWarn.slice(0, 30);
  result.page_errors = pErr.slice(0, 30);
  result.network.failed = failed.slice(0, 30);
  result.network.bad_status = bad.slice(0, 30);
  result.ok = result.reachable && !result.error;
  return result;
}

function featureNote(status, matched, total) {
  if (status === 'pass') return `Matched ${matched}/${total} key terms on the page.`;
  if (status === 'warn') return `Partially present (${matched}/${total} terms) — verify with the AI review.`;
  return `Only ${matched}/${total} key terms found — likely missing.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
