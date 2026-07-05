# 🌅 VercelCheck

A bot that **tests any of your Vercel deployments** — deployed *on* Vercel itself.

Paste a deployment URL, type what the app should include, and hit **Run test**. It
opens the page in a real headless Chromium (running in a Vercel serverless
function), **always** checks loading and the common bugs, then **OpenAI** reviews
the actual screenshots against the specifics you listed. Results come back on a
minimalistic, sunset-themed dashboard: a health score, per-category scores,
screenshots, a feature checklist and detailed drill-downs. It has a **light and
dark theme** (light by default) — toggle with the 🌙/🌞 button, remembered per browser.

---

## How it works

```
public/index.html     ← the sunset UI (static, self-contained)
api/test.js           ← Vercel serverless function: runs the audit + AI review
lib/
  browser.js          ← launches Chromium (@sparticuz/chromium on Vercel)
  runAudit.js         ← drives the page with puppeteer-core, collects raw signals
  pageAudit.js        ← the checks that run *inside* the page
  grade.js            ← turns the raw audit into graded checks + a 0-100 score
  ai.js               ← OpenAI-vision review of the screenshots
scripts/              ← local dev server + self-test (not used in production)
sample_site/          ← a deliberately buggy demo page to try it on
```

The front-end POSTs to `/api/test`, which launches Chromium, runs every check
across the chosen viewports, captures screenshots, grades everything, and calls
OpenAI — all in one request.

## What it checks

**Always, automatically:**

| Area | Examples |
| --- | --- |
| **Availability** | reachable, HTTP status, load time, HTTPS, blank/crashed page |
| **JavaScript** | uncaught exceptions, hydration/render errors, console errors & warnings |
| **Network** | failed requests, resources returning 4xx/5xx |
| **Layout** | horizontal overflow (sideways-scroll bug), broken images, missing `viewport` meta |
| **Loading** | spinners/skeletons still spinning after the page settles |
| **Responsive** | re-checked at Desktop / Tablet / Mobile, with screenshots |
| **Content & SEO** | `<title>`, meta description, favicon, `<h1>` structure |
| **Accessibility** | missing image `alt`, unlabeled controls & form inputs |

**Your specifics:** every line you type ("Dark mode toggle", "Pricing table with
three tiers", …) is matched on the page, and the OpenAI review looks at the
screenshots to give a per-specific verdict (present / partial / missing / broken)
and flag visual bugs a DOM scan can't see.

## Testing sites that need a login

Tick **“🔒 This site needs a login”** and give the bot an email/username and
password (use a throwaway test account). It navigates to the login page, fills
the form, submits, and then runs the whole audit as the **signed-in** user, so
your app's real pages are what get tested — not the login screen.

- **Login page URL** is optional; it defaults to the deployment URL. Set it if
  login lives at a separate path (e.g. `…/login`).
- Fields are **auto-detected** for common forms. If yours is unusual, open
  **Advanced** and give CSS selectors for the username field, password field
  and submit button. Simple two-step ("enter email → Next → password") flows are
  handled automatically. Captchas and 2FA are not.
- The result shows a **login status banner** so you know whether the bot got in.
- Credentials are sent only to your own serverless function to sign in for that
  one run — never stored or logged.

Two separate "logins" to be aware of: your **app's** login (above) and
**Vercel's deployment protection** (a Vercel SSO/password wall on Preview
deployments). The bot can't pass the latter — turn it off for the deployment
under test (Project → Settings → Deployment Protection) or test the public URL.

---

## Deploy to Vercel

1. Import this repo into Vercel (no framework preset needed — it's detected as
   static files + a Node function).
2. Add environment variables under **Project → Settings → Environment Variables**:
   - `OPENAI_API_KEY` — **required for the AI review** (the auto checks run without it).
   - `OPENAI_MODEL` — *optional*, defaults to `gpt-4o` (any vision-capable model, e.g. `gpt-4o-mini`).
3. Deploy. Open the site, paste a deployment URL, describe what to watch for, run.

`vercel.json` gives the function `maxDuration: 60` so a full audit + AI review
fits comfortably.

> The auto checks work with **no API key** — the AI review is the part that needs
> `OPENAI_API_KEY`. If it's missing, the dashboard just says the AI review wasn't run.

---

## Run locally

```bash
npm install
npx puppeteer browsers install chrome        # or point LOCAL_CHROME_PATH at any Chrome
LOCAL_CHROME_PATH="$(node -e "console.log(require('puppeteer-core').executablePath?'':'')")" # optional
OPENAI_API_KEY=sk-...  LOCAL_CHROME_PATH=/path/to/chrome  npm run dev
# open http://127.0.0.1:3000
```

`LOCAL_CHROME_PATH` tells the launcher to use a Chrome you already have instead of
the Lambda build (which only runs on Vercel). Setting it also enables testing
`localhost` URLs, which are blocked in production to prevent SSRF.

### Try it on the included demo

```bash
python3 -m http.server 8770 --directory sample_site
# in another shell:
LOCAL_CHROME_PATH=/path/to/chrome npm run selftest    # prints the graded audit
```

The demo page intentionally contains a horizontal-overflow bug, a broken image, a
missing `viewport` meta tag, a stuck spinner, a console error and a 404 fetch — so
every category lights up.
