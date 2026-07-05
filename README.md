# 🛰️ VercelCheck

A bot that **tests any of your Vercel deployments**. Give it a URL and a
plain-English description of what the app should include, and it drives a real
headless browser against the site to hunt for bugs — from common layout/loading
problems all the way to the niche, app-specific features you list.

It ships with a **minimalistic, visual dashboard**: an overall health score,
per-category scores, screenshots at multiple viewports, a feature checklist, and
detailed drill-downs.

<sub>Preview build: point it at your Preview / branch deploys, not just prod.</sub>

---

## What it checks

**Common bugs (always, automatically):**

| Area | Examples |
| --- | --- |
| **Availability** | reachable, HTTP status, load time, HTTPS, blank/crashed page |
| **JavaScript** | uncaught exceptions, hydration/render errors, console errors & warnings |
| **Network** | failed requests, resources returning 4xx/5xx |
| **Layout** | horizontal overflow (sideways-scroll bug), broken images, missing `viewport` meta |
| **Loading** | spinners/skeletons still spinning after the page settles |
| **Responsive** | layout re-checked at Desktop / Tablet / Mobile, with screenshots |
| **Content & SEO** | `<title>`, meta description, favicon, `<h1>` structure |
| **Accessibility** | missing image `alt`, unlabeled controls & form inputs |

**App-specific features (you describe them):**

Type one expectation per line — *"Working search bar in the header"*, *"Dark mode
toggle"*, *"Pricing table with three tiers"* — and the bot looks for each on the
page. Heuristic matching runs always; the optional **AI visual review** has
Claude look at the actual screenshots to confirm each feature is really there and
flag visual bugs a DOM scan can't see.

---

## Run it

```bash
pip install -r requirements.txt
python -m playwright install chromium   # one-time: download the browser
streamlit run streamlit_app.py
```

Then open http://localhost:8501, paste a deployment URL, describe what it should
include, and hit **Run test**.

### Optional: AI visual review

Set an Anthropic API key (or paste it into the "AI visual review" panel):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

The heuristic engine works fully without a key — the AI layer is an enhancement.

---

## Deploy the bot

- **Streamlit Community Cloud** — push this repo, set the main file to
  `streamlit_app.py`. `packages.txt` installs Chromium's system libraries and
  the app downloads the browser on first run. Add `ANTHROPIC_API_KEY` under
  *Secrets* if you want the AI review.
- **Codespaces / Dev Container** — the included `.devcontainer` installs
  everything and launches the app on attach.

> Note: this bot renders and tests *other* sites in a headless browser, so it
> needs a Python host with an outbound network (Streamlit Cloud, a container, a
> VM). It is not itself a static Vercel site.

---

## How it's built

```
streamlit_app.py        # the dashboard (entry point)
vercel_bot/
  engine.py             # headless-Chromium audit engine (runs as a subprocess)
  scoring.py            # turns a raw audit into graded checks + a health score
  ai.py                 # optional Claude-vision review of the screenshots
  styles.py             # CSS + HTML fragments for the visual UI
sample_site/            # a deliberately buggy demo page to try the bot on
```

The engine runs in a subprocess so Playwright's sync API never collides with
Streamlit's event loop. Screenshots are captured per viewport and fed to both
the dashboard and (optionally) Claude.

### Try it on the included demo

```bash
python -m http.server 8000 --directory sample_site
# then test  http://localhost:8000  in the app
```

The demo page intentionally contains a horizontal-overflow bug, a broken image,
a missing `viewport` meta tag, a stuck spinner, a console error and a 404 fetch —
so you can see every category light up.
