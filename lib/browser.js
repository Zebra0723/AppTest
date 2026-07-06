// Launch (or connect to) Chromium in a way that works on Vercel and locally.
//
// Modes, in priority order:
//   1. LOCAL_CHROME_PATH   → launch a local Chrome (used for local dev).
//   2. BROWSER_WS_ENDPOINT → connect to a REMOTE hosted Chrome over WebSocket
//      (Browserless / Browserbase). No Chromium runs in the function, so runtime
//      library problems (libnss3.so) can't happen. If the connection fails
//      (e.g. a wrong token → 401), we DON'T hard-fail — we fall back to (3).
//   3. @sparticuz/chromium bundled into the function. REQUIRES Vercel's Node
//      20.x runtime (Node 22 lacks libnss3/libnspr4). Pinned via package.json.
import puppeteer from 'puppeteer-core';

// THE fix for "libnss3.so / libnspr4.so: cannot open shared object file" on
// Vercel. @sparticuz/chromium decides whether to extract its Amazon Linux 2023
// shared libraries (libnss3, libnspr4, …) and set LD_LIBRARY_PATH based on the
// AWS_LAMBDA_JS_RUNTIME env var, which it reads when that module first loads.
// Vercel does NOT set it, so on Vercel the libraries are never extracted and
// Chromium fails to launch — on every Node version. We set it here, BEFORE
// @sparticuz is ever imported (it's only imported dynamically, further down),
// so the AL2023 code path activates and the libraries are unpacked. The literal
// "20.x" is the flag this package keys on for AL2023; it is correct for Vercel's
// Node 20/22 runtime. We only set it when unset, so real AWS Lambda is untouched.
if (!process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs20.x';
}

function normalizeWs(u) {
  u = String(u || '').trim();
  if (u.startsWith('https://')) return 'wss://' + u.slice(8);
  if (u.startsWith('http://')) return 'ws://' + u.slice(7);
  return u;
}

// Returns { browser, remote }. Callers close the browser when done.
export async function launchBrowser() {
  const local = process.env.LOCAL_CHROME_PATH;
  if (local) {
    const browser = await puppeteer.launch({
      executablePath: local,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    return { browser, remote: false };
  }

  // Remote hosted browser (preferred when configured).
  const ws = process.env.BROWSER_WS_ENDPOINT;
  let remoteErr = null;
  if (ws) {
    try {
      const browser = await puppeteer.connect({ browserWSEndpoint: normalizeWs(ws) });
      return { browser, remote: true };
    } catch (e) {
      remoteErr = e; // fall through to the bundled browser
    }
  }

  // Bundled Chromium (needs Node 20 on Vercel).
  try {
    const chromium = (await import('@sparticuz/chromium')).default;
    const browser = await puppeteer.launch({
      args: [...chromium.args, '--disable-dev-shm-usage'],
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
    });
    return { browser, remote: false };
  } catch (bundledErr) {
    throw new Error(describeFailure(ws, remoteErr, bundledErr));
  }
}

// Build one clear, actionable message when we couldn't get a browser at all.
function describeFailure(ws, remoteErr, bundledErr) {
  const bm = (bundledErr && bundledErr.message) || String(bundledErr);
  const parts = [];

  if (ws && remoteErr) {
    const rm = (remoteErr.message || String(remoteErr));
    const code = (rm.match(/\b(40\d|429|5\d\d)\b/) || [])[0];
    if (code === '401' || code === '403' || /unauthor|forbidden|invalid token|api key/i.test(rm)) {
      parts.push(
        `The hosted browser (BROWSER_WS_ENDPOINT) rejected the connection with ${code || 'an auth error'}. ` +
        `The token/apiKey in that URL is wrong, expired, or missing. ` +
        `Browserless: wss://production-sfo.browserless.io?token=YOUR_TOKEN — ` +
        `Browserbase: wss://connect.browserbase.com?apiKey=YOUR_KEY (also needs your project set up).`
      );
    } else {
      parts.push(`Couldn't reach the hosted browser (BROWSER_WS_ENDPOINT): ${rm}.`);
    }
    parts.push('Falling back to the bundled Chromium also failed.');
  }

  if (/libnss3|libnspr4|shared librar/i.test(bm)) {
    parts.push(
      'Chromium could not load its shared libraries (' + bm + '). ' +
      'This should be handled automatically now; if it persists, set an ' +
      'AWS_LAMBDA_JS_RUNTIME=nodejs20.x env var in Vercel, or use a hosted ' +
      'browser via BROWSER_WS_ENDPOINT.'
    );
  } else if (!parts.length) {
    parts.push(bm);
  } else {
    parts.push(bm);
  }
  return parts.join(' ');
}
