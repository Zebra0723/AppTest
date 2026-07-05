// Launch (or connect to) Chromium in a way that works on Vercel and locally.
//
// Three modes, in priority order:
//   1. LOCAL_CHROME_PATH   → launch a local Chrome (used for local dev).
//   2. BROWSER_WS_ENDPOINT → connect to a REMOTE hosted Chrome over WebSocket
//      (e.g. Browserless / Browserbase). This is the bulletproof option for
//      Vercel: no Chromium runs in the function, so runtime library problems
//      (libnss3.so etc.) can't happen. Set it to the service's wss URL,
//      including any token, e.g.
//        wss://production-sfo.browserless.io?token=XXXX
//        wss://connect.browserbase.com?apiKey=XXXX
//   3. default             → @sparticuz/chromium bundled into the function.
//      REQUIRES the Node.js 20.x runtime on Vercel (Node 22 is missing the
//      system libraries Chromium needs). Pinned via "engines" in package.json.
import puppeteer from 'puppeteer-core';

// Returns { browser, remote }. Callers should close the browser when done.
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

  const ws = process.env.BROWSER_WS_ENDPOINT;
  if (ws) {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws });
    return { browser, remote: true };
  }

  const chromium = (await import('@sparticuz/chromium')).default;
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--disable-dev-shm-usage'],
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: chromium.defaultViewport,
  });
  return { browser, remote: false };
}
