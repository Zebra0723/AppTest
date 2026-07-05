"""
Headless-browser audit engine for VercelCheck.

Drives a real Chromium (via Playwright) against a deployment URL and runs a
broad battery of checks: availability, JavaScript/console health, network
failures, layout & rendering bugs, stuck loaders, responsive behaviour across
viewports, SEO/meta, basic accessibility, and heuristic matching of the
user-declared feature list. Screenshots are captured per viewport.

The engine is intentionally usable in two ways:

  * imported and called via ``run_audit(config)`` (returns a dict), or
  * executed as a subprocess:  ``python -m vercel_bot.engine <config.json>``
    which prints the result dict as JSON on stdout.

Running it as a subprocess is what the Streamlit app does, so that Playwright's
sync API never collides with Streamlit's asyncio event loop.
"""

from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import time
import traceback
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Browser discovery
# ---------------------------------------------------------------------------

def _discover_chromium() -> Optional[str]:
    """Best-effort discovery of an already-installed Chromium binary.

    Returns an executable path, or ``None`` to let Playwright use its default
    (which is correct when the pip-installed playwright matches the browsers
    that ``playwright install`` fetched, e.g. on Streamlit Cloud).
    """
    base = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    roots = [base] if base else []
    roots.append(os.path.expanduser("~/.cache/ms-playwright"))
    patterns = [
        "chromium-*/chrome-linux/chrome",
        "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chromium-*/chrome-win/chrome.exe",
    ]
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for pat in patterns:
            hits = sorted(glob.glob(os.path.join(root, pat)))
            if hits:
                return hits[-1]  # newest build number
    return None


def ensure_chromium() -> bool:
    """Make sure a Chromium build is available, downloading it on first run.

    Returns True if a browser is present (or was just installed). Safe to call
    repeatedly — it's a no-op once the binary exists. This is what lets the app
    work on a fresh Streamlit Cloud container where no browser ships by default.
    """
    if _discover_chromium():
        return True
    try:
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            check=True, capture_output=True, timeout=600,
        )
    except Exception:
        return False
    return _discover_chromium() is not None


def _launch(playwright, proxy: Optional[str]):
    """Launch chromium, falling back to a discovered executable on failure."""
    from playwright.sync_api import Error as PWError

    args = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    launch_kwargs: Dict[str, Any] = {"headless": True, "args": args}
    if proxy:
        launch_kwargs["proxy"] = {"server": proxy}

    try:
        return playwright.chromium.launch(**launch_kwargs)
    except PWError:
        exe = _discover_chromium()
        if not exe:
            raise
        launch_kwargs["executable_path"] = exe
        return playwright.chromium.launch(**launch_kwargs)


# ---------------------------------------------------------------------------
# In-page audit script (runs inside the deployment being tested)
# ---------------------------------------------------------------------------

# Returns a structured snapshot of the DOM for a single viewport.
_AUDIT_JS = r"""
() => {
  const docEl = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // --- horizontal overflow (the classic mobile bug) ---
  const scrollW = Math.max(docEl.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const overflowPx = scrollW - vw;
  const offenders = [];
  if (overflowPx > 2) {
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 2) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 60),
          right: Math.round(r.right),
        });
        if (offenders.length >= 8) break;
      }
    }
  }

  // --- images ---
  const imgs = Array.from(document.images || []);
  let broken = [], missingAlt = 0;
  for (const im of imgs) {
    const failed = im.complete && im.naturalWidth === 0;
    if (failed && broken.length < 8) broken.push(im.currentSrc || im.src || '(inline)');
    if (!im.alt || !im.alt.trim()) missingAlt++;
  }

  // --- visible text / blankness ---
  const bodyText = (document.body ? document.body.innerText : '') || '';
  const trimmedLen = bodyText.replace(/\s+/g, ' ').trim().length;
  const renderedEls = document.querySelectorAll('body *').length;

  // --- meta / SEO ---
  const metaDesc = document.querySelector('meta[name="description"]');
  const viewportMeta = document.querySelector('meta[name="viewport"]');
  const favicon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"]');
  const canonical = document.querySelector('link[rel="canonical"]');
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogImage = document.querySelector('meta[property="og:image"]');
  const h1s = document.querySelectorAll('h1');

  // --- stuck loaders / skeletons still visible after settle ---
  const loaderSelectors = [
    '[class*="spinner" i]', '[class*="loader" i]', '[class*="loading" i]',
    '[class*="skeleton" i]', '[aria-busy="true"]', '[role="progressbar"]',
    '.animate-pulse'
  ];
  let visibleLoaders = 0;
  const loaderSample = [];
  for (const sel of loaderSelectors) {
    let nodes = [];
    try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      const shown = r.width > 0 && r.height > 0 &&
                    cs.visibility !== 'hidden' && cs.display !== 'none' &&
                    parseFloat(cs.opacity || '1') > 0.05;
      if (shown) {
        visibleLoaders++;
        if (loaderSample.length < 5) {
          loaderSample.push(sel + (n.className ? (' .' + n.className.toString().slice(0,40)) : ''));
        }
      }
    }
  }

  // --- basic accessibility ---
  let unlabeledControls = 0;
  const controls = document.querySelectorAll('button, a[href], [role="button"]');
  for (const c of controls) {
    const name = (c.innerText || '').trim() || c.getAttribute('aria-label') ||
                 c.getAttribute('title') || (c.querySelector('img[alt]') ? c.querySelector('img[alt]').alt : '');
    if (!name || !name.trim()) unlabeledControls++;
  }
  let unlabeledInputs = 0;
  const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
  for (const inp of inputs) {
    const id = inp.getAttribute('id');
    const hasLabel = (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')) ||
                     inp.closest('label') || inp.getAttribute('aria-label') ||
                     inp.getAttribute('aria-labelledby') || inp.getAttribute('placeholder');
    if (!hasLabel) unlabeledInputs++;
  }

  return {
    viewport: { w: vw, h: vh },
    overflow: { scrollWidth: scrollW, overflowPx: Math.max(0, overflowPx), offenders },
    images: { total: imgs.length, broken, missingAlt },
    content: { textLen: trimmedLen, elements: renderedEls, sample: bodyText.replace(/\s+/g,' ').trim().slice(0, 400) },
    meta: {
      title: (document.title || '').trim(),
      description: metaDesc ? (metaDesc.getAttribute('content') || '').trim() : null,
      hasViewportMeta: !!viewportMeta,
      hasFavicon: !!favicon,
      hasCanonical: !!canonical,
      hasOgTitle: !!ogTitle,
      hasOgImage: !!ogImage,
      lang: docEl.getAttribute('lang') || null,
      h1Count: h1s.length,
    },
    loaders: { visible: visibleLoaders, sample: loaderSample },
    a11y: { unlabeledControls, unlabeledInputs, totalControls: controls.length, totalInputs: inputs.length },
  };
}
"""


def _feature_probe_js(feature: str) -> str:
    """Build a JS expression that scores how present a declared feature is."""
    needle = json.dumps(feature.lower())
    return (
        "(() => {"
        f" const q = {needle};"
        " const words = q.split(/[^a-z0-9]+/).filter(w => w.length > 2);"
        " const text = ((document.body ? document.body.innerText : '') + ' ' +"
        "   Array.from(document.querySelectorAll('[aria-label],[placeholder],[alt],[title],button,a'))"
        "     .map(e => (e.getAttribute('aria-label')||'')+' '+(e.getAttribute('placeholder')||'')+' '+"
        "       (e.getAttribute('alt')||'')+' '+(e.getAttribute('title')||'')+' '+(e.innerText||'')).join(' ')"
        "   ).toLowerCase();"
        " if (!words.length) return { matched: 0, total: 0 };"
        " let hit = 0; for (const w of words) { if (text.includes(w)) hit++; }"
        " return { matched: hit, total: words.length };"
        " })()"
    )


# ---------------------------------------------------------------------------
# Main audit
# ---------------------------------------------------------------------------

def run_audit(config: Dict[str, Any]) -> Dict[str, Any]:
    from playwright.sync_api import sync_playwright, Error as PWError

    url: str = config["url"]
    features: List[str] = config.get("features") or []
    viewports: List[Dict[str, Any]] = config.get("viewports") or [
        {"name": "Desktop", "width": 1440, "height": 900},
        {"name": "Tablet", "width": 768, "height": 1024},
        {"name": "Mobile", "width": 390, "height": 844},
    ]
    wait_extra_ms: int = int(config.get("wait_extra_ms", 2500))
    outdir: str = config.get("outdir") or "."
    proxy: Optional[str] = config.get("proxy") or os.environ.get("VERCELCHECK_PROXY")
    os.makedirs(outdir, exist_ok=True)

    result: Dict[str, Any] = {
        "url": url,
        "ok": False,
        "reachable": False,
        "metrics": {},
        "console": {"errors": [], "warnings": []},
        "page_errors": [],
        "network": {"failed": [], "bad_status": []},
        "viewport_reports": [],
        "screenshots": [],
        "features": [],
        "checks": [],
        "page_text": "",
        "error": None,
    }

    console_errors: List[str] = []
    console_warnings: List[str] = []
    page_errors: List[str] = []
    failed_requests: List[Dict[str, str]] = []
    bad_status: List[Dict[str, Any]] = []
    seen_console = set()

    try:
        with sync_playwright() as p:
            browser = _launch(p, proxy)
            context = browser.new_context(
                viewport={"width": viewports[0]["width"], "height": viewports[0]["height"]},
                ignore_https_errors=True,
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 VercelCheckBot/1.0"
                ),
            )
            page = context.new_page()

            def on_console(msg):
                try:
                    typ = msg.type
                    txt = msg.text
                except Exception:
                    return
                key = (typ, txt)
                if key in seen_console:
                    return
                seen_console.add(key)
                if typ == "error":
                    console_errors.append(txt[:500])
                elif typ == "warning":
                    console_warnings.append(txt[:500])

            def on_pageerror(exc):
                page_errors.append(str(exc)[:500])

            def on_requestfailed(req):
                fail = req.failure or ""
                # Chromium reports aborted requests during navigation; keep signal, drop noise.
                if "ERR_ABORTED" in (fail or ""):
                    return
                failed_requests.append({"url": req.url[:200], "reason": (fail or "")[:120]})

            def on_response(resp):
                try:
                    st = resp.status
                    if st >= 400:
                        bad_status.append({"url": resp.url[:200], "status": st})
                except Exception:
                    pass

            page.on("console", on_console)
            page.on("pageerror", on_pageerror)
            page.on("requestfailed", on_requestfailed)
            page.on("response", on_response)

            # --- navigate ---
            t0 = time.time()
            main_status = None
            main_headers: Dict[str, str] = {}
            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=45000)
                if response is not None:
                    main_status = response.status
                    try:
                        main_headers = {k.lower(): v for k, v in response.headers.items()}
                    except Exception:
                        main_headers = {}
                result["reachable"] = True
            except PWError as nav_err:
                result["error"] = f"Navigation failed: {nav_err}"
                result["metrics"]["nav_error"] = str(nav_err)[:300]
                browser.close()
                _finalize(result, console_errors, console_warnings, page_errors,
                          failed_requests, bad_status)
                return result

            dcl_ms = int((time.time() - t0) * 1000)
            try:
                page.wait_for_load_state("load", timeout=20000)
            except PWError:
                pass
            load_ms = int((time.time() - t0) * 1000)
            try:
                page.wait_for_load_state("networkidle", timeout=8000)
            except PWError:
                pass
            # Give SPA hydration / client fetches time to settle.
            page.wait_for_timeout(wait_extra_ms)
            settle_ms = int((time.time() - t0) * 1000)

            result["metrics"] = {
                "http_status": main_status,
                "dom_content_loaded_ms": dcl_ms,
                "load_ms": load_ms,
                "settled_ms": settle_ms,
                "final_url": page.url,
                "is_https": page.url.startswith("https://"),
                "security_headers": {
                    "content-security-policy": bool(main_headers.get("content-security-policy")),
                    "strict-transport-security": bool(main_headers.get("strict-transport-security")),
                    "x-frame-options": bool(main_headers.get("x-frame-options")),
                    "x-content-type-options": bool(main_headers.get("x-content-type-options")),
                },
                "server": main_headers.get("server", ""),
                "x_vercel_id": main_headers.get("x-vercel-id", ""),
            }

            # --- per-viewport audit + screenshots ---
            first_audit = None
            for i, vp in enumerate(viewports):
                page.set_viewport_size({"width": vp["width"], "height": vp["height"]})
                page.wait_for_timeout(500)  # allow reflow / responsive JS
                try:
                    audit = page.evaluate(_AUDIT_JS)
                except PWError as e:
                    audit = {"error": str(e)[:200]}
                audit["name"] = vp["name"]
                shot_path = os.path.join(outdir, f"shot_{i}_{vp['name'].lower()}.png")
                try:
                    page.screenshot(path=shot_path, full_page=(i == 0), animations="disabled")
                    audit["screenshot"] = shot_path
                    result["screenshots"].append({"name": vp["name"], "path": shot_path,
                                                   "width": vp["width"], "height": vp["height"]})
                except PWError:
                    audit["screenshot"] = None
                result["viewport_reports"].append(audit)
                if first_audit is None:
                    first_audit = audit

            # --- feature heuristics (run at desktop viewport) ---
            page.set_viewport_size({"width": viewports[0]["width"], "height": viewports[0]["height"]})
            for feat in features:
                feat = feat.strip()
                if not feat:
                    continue
                try:
                    probe = page.evaluate(_feature_probe_js(feat))
                except PWError:
                    probe = {"matched": 0, "total": 0}
                total = probe.get("total", 0) or 0
                matched = probe.get("matched", 0) or 0
                ratio = (matched / total) if total else 0.0
                if ratio >= 0.75:
                    status = "pass"
                elif ratio >= 0.34:
                    status = "warn"
                else:
                    status = "fail"
                result["features"].append({
                    "feature": feat,
                    "status": status,
                    "matched_terms": matched,
                    "total_terms": total,
                    "note": _feature_note(status, matched, total),
                })

            # capture page text digest for the AI layer
            try:
                result["page_text"] = (first_audit or {}).get("content", {}).get("sample", "")
            except Exception:
                result["page_text"] = ""

            browser.close()

    except Exception as e:  # pragma: no cover - defensive
        result["error"] = f"{type(e).__name__}: {e}"
        result["traceback"] = traceback.format_exc()[-1500:]

    _finalize(result, console_errors, console_warnings, page_errors,
              failed_requests, bad_status)
    return result


def _feature_note(status: str, matched: int, total: int) -> str:
    if status == "pass":
        return f"Matched {matched}/{total} key terms on the page."
    if status == "warn":
        return f"Partially present ({matched}/{total} terms) — verify manually or with AI."
    return f"Only {matched}/{total} key terms found — likely missing."


def _finalize(result, console_errors, console_warnings, page_errors,
              failed_requests, bad_status) -> None:
    result["console"]["errors"] = console_errors[:30]
    result["console"]["warnings"] = console_warnings[:30]
    result["page_errors"] = page_errors[:30]
    result["network"]["failed"] = failed_requests[:30]
    result["network"]["bad_status"] = bad_status[:30]
    result["ok"] = result["reachable"] and result.get("error") is None


# ---------------------------------------------------------------------------
# CLI entry point (used as a subprocess by the Streamlit app)
# ---------------------------------------------------------------------------

def _main(argv: List[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({"error": "usage: engine.py <config.json>"}))
        return 2
    with open(argv[1], "r", encoding="utf-8") as fh:
        config = json.load(fh)
    result = run_audit(config)
    out = config.get("result_path")
    payload = json.dumps(result)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
