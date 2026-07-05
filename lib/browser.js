// Launch Chromium in a way that works on Vercel and locally.
//
// IMPORTANT: on Vercel this must run on the Node.js 20.x runtime. Vercel's Node
// 22.x runtime is missing system libraries Chromium needs (libnss3.so /
// libnspr4.so), which causes "error while loading shared libraries". The Node
// version is pinned via "engines" in package.json AND should be set to 20.x in
// the Vercel project settings. See README "Deploy to Vercel".
//
// Locally, set LOCAL_CHROME_PATH to a Chrome/Chromium you already have.
import puppeteer from 'puppeteer-core';

export async function launchBrowser() {
  const local = process.env.LOCAL_CHROME_PATH;
  if (local) {
    return puppeteer.launch({
      executablePath: local,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }

  const chromium = (await import('@sparticuz/chromium')).default;
  return puppeteer.launch({
    args: [...chromium.args, '--disable-dev-shm-usage'],
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: chromium.defaultViewport,
  });
}
