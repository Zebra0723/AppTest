// Automated form login: drive a login page (fill username + password, submit),
// then leave the page authenticated so the main audit runs as a signed-in user.
//
// Written to be robust on real-world login pages: dismisses cookie/consent
// overlays, waits for lazy-rendered forms, fills React-controlled inputs
// reliably, submits several ways, and detects success without depending on a
// full-page navigation (SPAs often don't navigate). Returns a `steps` trail so
// failures are diagnosable.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER_CANDIDATES = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[type="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="login" i]',
  'input[id*="login" i]',
  'input[type="text"]',
  'input[type="tel"]',
  'input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])',
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

// Fill an input reliably — typing first (fires real key events for React), then
// verifying and, if needed, setting the value + dispatching input/change.
async function fill(page, handle, value) {
  if (!handle || value == null) return;
  const v = String(value);
  try { await handle.click({ clickCount: 3 }); } catch (e) { /* noop */ }
  try { await handle.type(v, { delay: 15 }); } catch (e) { /* noop */ }
  try {
    const ok = await page.evaluate((el, val) => el.value === val, handle, v);
    if (!ok) {
      await page.evaluate((el, val) => {
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, handle, v);
    }
  } catch (e) { /* noop */ }
}

// Click common cookie/consent buttons that overlay and block the form.
async function dismissOverlays(page) {
  try {
    await page.evaluate(() => {
      const rx = /^(accept|accept all|agree|i agree|allow all|got it|consent|ok)\b/i;
      const els = [...document.querySelectorAll('button, [role="button"], a')];
      for (const e of els) {
        const t = (e.innerText || '').trim();
        if (t && t.length < 30 && rx.test(t) && e.offsetParent !== null) { try { e.click(); } catch (x) {} }
      }
    });
  } catch (e) { /* noop */ }
}

async function visiblePassword(page) {
  return page.evaluate(() => {
    for (const p of document.querySelectorAll('input[type="password"]')) {
      const r = p.getBoundingClientRect();
      const cs = getComputedStyle(p);
      if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') return true;
    }
    return false;
  }).catch(() => true);
}

async function clickSubmit(page, submitSelector, passHandle) {
  if (submitSelector) {
    const b = await page.$(submitSelector).catch(() => null);
    if (b) { await b.click().catch(() => {}); return true; }
  }
  const btn = await page.evaluateHandle(() => {
    const rx = /\b(log ?in|sign ?in|continue|next|submit|log ?on|get started|proceed|enter)\b/i;
    const els = [...document.querySelectorAll('button, input[type="submit"], [role="button"], a')];
    // Prefer real submit buttons / matching text.
    for (const e of els) {
      if (e.offsetParent === null) continue;
      const t = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim();
      if (t && rx.test(t)) return e;
    }
    return document.querySelector('button[type="submit"], input[type="submit"], form button');
  }).catch(() => null);
  const el = btn && btn.asElement && btn.asElement();
  if (el) { await el.click().catch(() => {}); return true; }
  if (passHandle) { await passHandle.press('Enter').catch(() => {}); return true; }
  return false;
}

// A narrow "is there an email/username box here?" check (avoids matching search bars).
async function hasEmailish(page) {
  return firstVisible(page, [
    'input[autocomplete="username"]', 'input[autocomplete="email"]', 'input[type="email"]',
    'input[name*="email" i]', 'input[id*="email" i]', 'input[name*="user" i]', 'input[id*="user" i]',
  ]);
}

// Click a "Log in" / "Sign in" / "Account" link to reach the actual login form,
// for when the URL given is a homepage rather than the login page itself.
async function clickLoginLink(page) {
  const h = await page.evaluateHandle(() => {
    const rx = /^(log ?in|sign ?in|login|account|my account|sign into|members?)/i;
    const els = [...document.querySelectorAll('a, button, [role="button"]')];
    for (const e of els) {
      if (e.offsetParent === null) continue;
      const t = (e.innerText || e.getAttribute('aria-label') || '').trim();
      if (t && t.length < 24 && rx.test(t)) return e;
    }
    return null;
  }).catch(() => null);
  const el = h && h.asElement && h.asElement();
  if (el) { await el.click().catch(() => {}); return true; }
  return false;
}

async function detectError(page) {
  return page.evaluate(() => {
    const rx = /invalid|incorrect|wrong|failed|not match|doesn't match|denied|unauthor|try again|couldn.t|error/i;
    const sels = ['[role="alert"]', '[class*="error" i]', '[class*="invalid" i]', '[class*="danger" i]', '.alert', '[aria-invalid="true"]'];
    for (const s of sels) {
      for (const e of document.querySelectorAll(s)) {
        const t = (e.innerText || '').trim();
        if (t && t.length < 200 && rx.test(t)) return t.slice(0, 140);
      }
    }
    return '';
  }).catch(() => '');
}

// Wait for the page to react to a submit: navigation, or network idle, or the
// password field disappearing — whichever happens first.
async function waitSettled(page) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
    page.waitForNetworkIdle({ idleTime: 600, timeout: 12000 }).catch(() => {}),
    (async () => { for (let i = 0; i < 24; i++) { if (!(await visiblePassword(page))) return; await sleep(500); } })(),
  ]);
  await sleep(600);
}

export async function performLogin(page, auth) {
  const result = { attempted: true, success: false, detail: '', steps: [] };
  const loginUrl = auth.loginUrl || auth.targetUrl;
  const step = (s) => result.steps.push(s);

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    result.detail = `Couldn't load the login page (${e && e.message ? e.message : e}).`;
    return result;
  }
  await sleep(1000);
  await dismissOverlays(page);
  await page.waitForSelector('input[type="password"]', { timeout: 8000 }).catch(() => {});

  // If this page has no login form (no password box and no email box), it's
  // probably a homepage — click a "Log in" link to reach the actual form.
  if (!(await page.$('input[type="password"]')) && !(await hasEmailish(page))) {
    if (await clickLoginLink(page)) {
      step('clicked a "Log in" link to reach the form');
      await waitSettled(page);
      await dismissOverlays(page);
      await page.waitForSelector('input[type="password"]', { timeout: 8000 }).catch(() => {});
    } else {
      step('no login form and no "Log in" link found on this page');
    }
  }

  // Username
  const userHandle = auth.userSelector
    ? await page.$(auth.userSelector).catch(() => null)
    : await firstVisible(page, USER_CANDIDATES);
  if (userHandle) { await fill(page, userHandle, auth.username); step('filled username'); }
  else step('no username field found');

  // Password — same screen, or after a "Next" step.
  const passSel = auth.passSelector || 'input[type="password"]';
  let passHandle = await page.$(passSel).catch(() => null);
  if (!passHandle) {
    step('no password yet — trying two-step');
    await clickSubmit(page, auth.submitSelector, null);
    await page.waitForSelector(passSel, { timeout: 8000 }).catch(() => {});
    await sleep(600);
    passHandle = await page.$(passSel).catch(() => null);
    if (passHandle) step('advanced to password screen');
  }
  if (!passHandle) {
    result.detail = `Couldn't find the password field. Steps: ${result.steps.join(' → ')}. ` +
      'Open "Advanced" in the login panel and give a CSS selector for the password field.';
    return result;
  }
  await fill(page, passHandle, auth.password);
  step('filled password');

  // Submit — click, then Enter, then submit the form element, until the form clears.
  await dismissOverlays(page);
  await clickSubmit(page, auth.submitSelector, passHandle);
  await waitSettled(page);
  if (await visiblePassword(page)) {
    step('still on form after click — pressing Enter');
    try { await passHandle.press('Enter'); } catch (e) { /* noop */ }
    await waitSettled(page);
  }
  if (await visiblePassword(page)) {
    step('still on form — submitting form element');
    await page.evaluate(() => {
      const p = document.querySelector('input[type="password"]');
      const f = p && p.form;
      if (f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); }
    }).catch(() => {});
    await waitSettled(page);
  }

  // Verdict
  const err = await detectError(page);
  const stillThere = await visiblePassword(page);
  if (!stillThere && !err) {
    result.success = true;
    result.detail = 'the login form is gone, so sign-in worked.';
  } else if (err) {
    result.detail = `sign-in failed — the page said: "${err}". Check the email/password.`;
  } else {
    result.detail = `submitted but the login form is still showing. Steps: ${result.steps.join(' → ')}. ` +
      'The email/password may be wrong, or the fields need custom selectors (Advanced).';
  }
  return result;
}
