// Launch Chromium in a way that works on Vercel and locally.
//
// On Vercel we use @sparticuz/chromium-min and download the full Chromium +
// shared-library pack at runtime. This is the approach @sparticuz recommends
// for Vercel: it sidesteps the serverless file-tracing/bundling problems that
// otherwise leave Chromium unable to find its libraries (e.g. libnss3.so).
//
// Locally, set LOCAL_CHROME_PATH to a Chrome/Chromium you already have.
import puppeteer from 'puppeteer-core';

// The pack matches the installed @sparticuz/chromium-min version. Override with
// the CHROMIUM_PACK_URL env var if you'd rather host the pack yourself.
const DEFAULT_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.0/chromium-v131.0.0-pack.tar';

export async function launchBrowser() {
  const local = process.env.LOCAL_CHROME_PATH;
  if (local) {
    return puppeteer.launch({
      executablePath: local,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }

  const chromium = (await import('@sparticuz/chromium-min')).default;
  const packUrl = process.env.CHROMIUM_PACK_URL || DEFAULT_PACK_URL;
  return puppeteer.launch({
    args: [...chromium.args, '--disable-dev-shm-usage'],
    executablePath: await chromium.executablePath(packUrl),
    headless: chromium.headless,
    defaultViewport: chromium.defaultViewport,
  });
}
