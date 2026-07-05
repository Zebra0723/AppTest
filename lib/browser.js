// Launch Chromium in a way that works on Vercel (via @sparticuz/chromium) and
// locally (via a chrome you already have — set LOCAL_CHROME_PATH).
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
  // Vercel / AWS Lambda serverless environment.
  const chromium = (await import('@sparticuz/chromium')).default;
  return puppeteer.launch({
    args: [...chromium.args, '--disable-dev-shm-usage'],
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: chromium.defaultViewport,
  });
}
