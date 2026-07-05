// Automated form login: drive a login page (fill username + password, submit),
// then leave the page authenticated so the main audit runs as a signed-in user.
//
// Best-effort auto-detection of the fields is used when explicit selectors are
// not supplied. Handles the common single-form case and simple two-step
// ("enter email → Next → enter password") flows.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER_CANDIDATES = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="login" i]',
  'input[type="text"]',
  'input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"])',
];

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const handles = await page.$$(sel).catch(() => []);
    for (const h of handles) {
      const box = await h.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) return h;
    }
  }
  return null;
}

async function typeInto(handle, value) {
  if (!handle || value == null) return;
  await handle.click({ clickCount: 3 }).catch(() => {});
  await handle.type(String(value), { delay: 12 }).catch(() => {});
}

async function clickSubmit(page, submitSelector, passHandle) {
  if (submitSelector) {
    const b = await page.$(submitSelector).catch(() => null);
    if (b) { await b.click().catch(() => {}); return true; }
  }
  // Find a button whose text looks like a login/submit action.
  const btn = await page.evaluateHandle(() => {
    const rx = /log ?in|sign ?in|continue|next|submit|log ?on|get started/i;
    const els = [...document.querySelectorAll('button, input[type="submit"], [role="button"], a[href]')];
    for (const e of els) {
      const t = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim();
      if (t && rx.test(t)) return e;
    }
    return document.querySelector('button[type="submit"], input[type="submit"], button');
  }).catch(() => null);
  const el = btn && btn.asElement && btn.asElement();
  if (el) { await el.click().catch(() => {}); return true; }
  // Last resort: submit the form by pressing Enter in the password field.
  if (passHandle) { await passHandle.press('Enter').catch(() => {}); return true; }
  return false;
}

async function detectError(page) {
  return page.evaluate(() => {
    const rx = /invalid|incorrect|wrong|failed|not match|try again|denied|unauthor/i;
    const sels = ['[role="alert"]', '[class*="error" i]', '[class*="invalid" i]', '.alert', '[aria-invalid="true"]'];
    for (const s of sels) {
      for (const e of document.querySelectorAll(s)) {
        const t = (e.innerText || '').trim();
        if (t && rx.test(t)) return t.slice(0, 140);
      }
    }
    return '';
  }).catch(() => '');
}

export async function performLogin(page, auth) {
  const result = { attempted: true, success: false, detail: '' };
  const loginUrl = auth.loginUrl || auth.targetUrl;
  const passSel = auth.passSelector || 'input[type="password"]';

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    result.detail = `Could not load the login page (${e && e.message ? e.message : e}).`;
    return result;
  }
  await sleep(700);

  // Username
  const userHandle = auth.userSelector
    ? await page.$(auth.userSelector).catch(() => null)
    : await firstVisible(page, USER_CANDIDATES);
  if (userHandle) await typeInto(userHandle, auth.username);

  // Password — may appear on the same screen or after a "Next" step.
  let passHandle = await page.$(passSel).catch(() => null);
  if (!passHandle) {
    await clickSubmit(page, auth.submitSelector, null); // advance the two-step flow
    await page.waitForSelector(passSel, { timeout: 8000 }).catch(() => {});
    await sleep(400);
    passHandle = await page.$(passSel).catch(() => null);
  }
  if (!passHandle) {
    result.detail = 'Could not find a password field on the login page. Try setting a custom password selector.';
    return result;
  }
  await typeInto(passHandle, auth.password);

  // Submit and wait for the result.
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
    clickSubmit(page, auth.submitSelector, passHandle),
  ]);
  await page.waitForNetworkIdle({ idleTime: 600, timeout: 6000 }).catch(() => {});
  await sleep(400);

  const stillPass = await page.$(passSel).catch(() => null);
  const err = await detectError(page);
  if (!stillPass && !err) {
    result.success = true;
    result.detail = 'the login form is no longer present after submitting.';
  } else if (err) {
    result.detail = `Login appears to have failed: “${err}”.`;
  } else {
    result.detail = 'The login form is still showing after submit — the credentials or selectors may be wrong.';
  }
  return result;
}
