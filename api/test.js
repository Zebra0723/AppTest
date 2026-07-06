// POST /api/test  { url, details, viewports?, settleMs? }
// Runs the always-on browser audit (loading + common bugs) and then the OpenAI
// review, and returns the graded report. OPENAI_API_KEY is read from the
// Vercel project's environment variables.
import { runAudit } from '../lib/runAudit.js';
import { grade } from '../lib/grade.js';
import { aiReview, aiConfigured } from '../lib/ai.js';

const VIEWPORT_PRESETS = {
  Desktop: { name: 'Desktop', width: 1440, height: 900 },
  Tablet: { name: 'Tablet', width: 768, height: 1024 },
  Mobile: { name: 'Mobile', width: 390, height: 844 },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }

  const url = normalizeUrl(body.url);
  const guard = guardUrl(url);
  if (!guard.ok) {
    res.status(400).json({ error: guard.reason });
    return;
  }

  const details = String(body.details || '');
  const features = details.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 40);

  let names = Array.isArray(body.viewports) && body.viewports.length ? body.viewports : ['Desktop', 'Mobile'];
  names = names.filter((n) => VIEWPORT_PRESETS[n]);
  if (!names.length) names = ['Desktop', 'Mobile'];
  const viewports = names.map((n) => VIEWPORT_PRESETS[n]);

  const settleMs = clamp(parseInt(body.settleMs, 10) || 2500, 500, 8000);

  // Optional automated form login.
  let auth = null;
  const a = body.auth;
  if (a && typeof a === 'object' && a.password && (a.username || a.userSelector)) {
    let loginUrl = a.loginUrl ? normalizeUrl(a.loginUrl) : url;
    const lg = guardUrl(loginUrl);
    if (!lg.ok) { res.status(400).json({ error: `Login URL: ${lg.reason}` }); return; }
    auth = {
      loginUrl,
      username: String(a.username || ''),
      password: String(a.password || ''),
      userSelector: a.userSelector ? String(a.userSelector) : null,
      passSelector: a.passSelector ? String(a.passSelector) : null,
      submitSelector: a.submitSelector ? String(a.submitSelector) : null,
    };
  }

  try {
    const audit = await runAudit({ url, features, viewports, waitExtraMs: settleMs, auth });
    const report = grade(audit);

    // aiReview() returns a helpful reason when no key is configured, so just
    // call it whenever the page loaded.
    let ai = { available: false, reason: 'AI review not run (page did not load).' };
    if (audit.reachable) {
      ai = await aiReview(audit, features);
    }

    // Convert screenshots to data URLs for the client and drop raw text weight.
    const screenshots = (audit.screenshots || []).map((s) => ({
      name: s.name, width: s.width, height: s.height,
      dataUrl: s.b64 ? `data:image/png;base64,${s.b64}` : null,
    }));

    res.status(200).json({
      url,
      report,
      ai,
      aiConfigured: aiConfigured(),
      screenshots,
      features: audit.features,
      metrics: audit.metrics,
      reachable: audit.reachable,
      login: audit.login,
      error: audit.error,
      raw: { console: audit.console, page_errors: audit.page_errors, network: audit.network },
    });
  } catch (e) {
    res.status(500).json({ error: `Test failed: ${e && e.message ? e.message : e}` });
  }
}

function normalizeUrl(raw) {
  raw = String(raw || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  return raw;
}

function guardUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, reason: 'Please enter a valid URL.' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'Only http/https URLs are supported.' };
  // Allow loopback only in local dev (where we intentionally test 127.0.0.1).
  const dev = !!process.env.LOCAL_CHROME_PATH;
  if (!dev) {
    const h = u.hostname.toLowerCase();
    const blocked = (
      h === 'localhost' || h === '0.0.0.0' || h === '::1' ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h.endsWith('.internal') || h.endsWith('.local')
    );
    if (blocked) return { ok: false, reason: 'That host looks internal/private and can\'t be tested.' };
  }
  return { ok: true };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
