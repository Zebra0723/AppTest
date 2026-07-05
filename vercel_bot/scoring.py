"""
Turn a raw engine audit into a graded report: a list of categorized checks,
each with a pass / warn / fail / info status, plus an overall health score.

Kept deliberately separate from the engine so the grading logic is easy to
read, tune, and unit-test without a browser.
"""

from __future__ import annotations

from typing import Any, Dict, List

PASS, WARN, FAIL, INFO = "pass", "warn", "fail", "info"

# How much each category can subtract from a perfect 100.
_CATEGORY_WEIGHTS = {
    "Availability": 30,
    "JavaScript": 18,
    "Network": 12,
    "Layout": 16,
    "Loading": 10,
    "Responsive": 8,
    "Content & SEO": 4,
    "Accessibility": 2,
}

_STATUS_PENALTY = {PASS: 0.0, INFO: 0.0, WARN: 0.5, FAIL: 1.0}


def _check(cat: str, label: str, status: str, detail: str,
           evidence: List[str] | None = None, weight: float = 1.0) -> Dict[str, Any]:
    return {
        "category": cat,
        "label": label,
        "status": status,
        "detail": detail,
        "evidence": evidence or [],
        "weight": weight,
    }


def grade(audit: Dict[str, Any]) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []
    m = audit.get("metrics", {})

    # ---------------- Availability ----------------
    if not audit.get("reachable"):
        checks.append(_check(
            "Availability", "Deployment reachable", FAIL,
            audit.get("error") or "The page could not be loaded at all.",
            weight=3.0))
        # Short-circuit: nothing else is meaningful.
        return _assemble(audit, checks)

    status_code = m.get("http_status")
    if status_code and status_code < 400:
        checks.append(_check("Availability", "HTTP response", PASS,
                             f"Server returned {status_code}."))
    elif status_code:
        checks.append(_check("Availability", "HTTP response", FAIL,
                             f"Server returned {status_code}.", weight=3.0))
    else:
        checks.append(_check("Availability", "HTTP response", WARN,
                             "No main HTTP status was captured (client-side redirect?)."))

    load_ms = m.get("load_ms") or 0
    if load_ms and load_ms < 2500:
        checks.append(_check("Availability", "Load time", PASS, f"Loaded in {load_ms} ms."))
    elif load_ms < 5000:
        checks.append(_check("Availability", "Load time", WARN,
                             f"Loaded in {load_ms} ms — a little slow.", weight=0.6))
    elif load_ms:
        checks.append(_check("Availability", "Load time", FAIL,
                             f"Took {load_ms} ms to load — users will notice.", weight=1.2))

    if m.get("is_https"):
        checks.append(_check("Availability", "HTTPS", PASS, "Served over HTTPS."))
    else:
        checks.append(_check("Availability", "HTTPS", WARN, "Not served over HTTPS.", weight=1.0))

    # ---------------- Blank / crashed page ----------------
    first = _first_report(audit)
    text_len = first.get("content", {}).get("textLen", 0)
    el_count = first.get("content", {}).get("elements", 0)
    if text_len < 8 and el_count < 12:
        checks.append(_check(
            "Availability", "Rendered content", FAIL,
            "The page rendered essentially blank (no visible text/elements). "
            "Common with a build error, a crashed root component, or an "
            "unhandled exception during hydration.", weight=3.0))
    elif text_len < 40:
        checks.append(_check("Availability", "Rendered content", WARN,
                             f"Very little visible text ({text_len} chars).", weight=1.0))
    else:
        checks.append(_check("Availability", "Rendered content", PASS,
                             f"{text_len} chars of visible text rendered."))

    # ---------------- JavaScript / console ----------------
    perrs = audit.get("page_errors", [])
    if perrs:
        checks.append(_check("JavaScript", "Uncaught exceptions", FAIL,
                             f"{len(perrs)} uncaught JavaScript exception(s) thrown.",
                             evidence=perrs[:5], weight=2.0))
    else:
        checks.append(_check("JavaScript", "Uncaught exceptions", PASS,
                             "No uncaught JavaScript exceptions."))

    cerrs = audit.get("console", {}).get("errors", [])
    hydration = [e for e in cerrs if _is_hydration(e)]
    if hydration:
        checks.append(_check("JavaScript", "Hydration / render errors", FAIL,
                             f"{len(hydration)} hydration/render error(s) in the console.",
                             evidence=hydration[:4], weight=1.5))
    if cerrs:
        checks.append(_check("JavaScript", "Console errors", WARN if len(cerrs) <= 3 else FAIL,
                             f"{len(cerrs)} console error(s).", evidence=cerrs[:6],
                             weight=1.0 if len(cerrs) <= 3 else 1.5))
    else:
        checks.append(_check("JavaScript", "Console errors", PASS, "Console is clean."))

    cwarn = audit.get("console", {}).get("warnings", [])
    if cwarn:
        checks.append(_check("JavaScript", "Console warnings", INFO,
                             f"{len(cwarn)} console warning(s).", evidence=cwarn[:4]))

    # ---------------- Network ----------------
    failed = audit.get("network", {}).get("failed", [])
    bad = audit.get("network", {}).get("bad_status", [])
    if failed:
        checks.append(_check("Network", "Failed requests", FAIL,
                             f"{len(failed)} request(s) failed to load.",
                             evidence=[f"{x['url']} ({x['reason']})" for x in failed[:6]],
                             weight=1.5))
    else:
        checks.append(_check("Network", "Failed requests", PASS, "No failed network requests."))

    if bad:
        server_err = [x for x in bad if x["status"] >= 500]
        checks.append(_check("Network", "Broken resources", FAIL if server_err else WARN,
                             f"{len(bad)} resource(s) returned 4xx/5xx.",
                             evidence=[f"{x['status']}  {x['url']}" for x in bad[:6]],
                             weight=1.5 if server_err else 1.0))
    else:
        checks.append(_check("Network", "Broken resources", PASS,
                             "All resources returned OK."))

    # ---------------- Layout / rendering ----------------
    overflow_reports = [(r.get("name"), r.get("overflow", {})) for r in audit.get("viewport_reports", [])]
    worst = [(name, ov) for name, ov in overflow_reports if ov.get("overflowPx", 0) > 4]
    if worst:
        ev = []
        for name, ov in worst:
            offs = ", ".join(f"<{o['tag']} .{o['cls']}>" for o in ov.get("offenders", [])[:3])
            ev.append(f"{name}: +{ov['overflowPx']}px overflow. {offs}")
        checks.append(_check("Layout", "Horizontal overflow", FAIL if any(n == "Mobile" for n, _ in worst) else WARN,
                             "Content overflows horizontally (causes sideways scroll / broken layout).",
                             evidence=ev, weight=1.5))
    else:
        checks.append(_check("Layout", "Horizontal overflow", PASS,
                             "No horizontal overflow at any viewport."))

    broken_imgs, missing_alt = [], 0
    for r in audit.get("viewport_reports", []):
        broken_imgs = r.get("images", {}).get("broken", []) or broken_imgs
        missing_alt = max(missing_alt, r.get("images", {}).get("missingAlt", 0))
    if broken_imgs:
        checks.append(_check("Layout", "Broken images", FAIL,
                             f"{len(broken_imgs)} image(s) failed to render.",
                             evidence=broken_imgs[:6], weight=1.2))
    else:
        checks.append(_check("Layout", "Broken images", PASS, "All images rendered."))

    if not first.get("meta", {}).get("hasViewportMeta", True):
        checks.append(_check("Layout", "Responsive meta tag", FAIL,
                             "Missing <meta name=viewport> — mobile rendering will be broken.",
                             weight=1.2))
    else:
        checks.append(_check("Layout", "Responsive meta tag", PASS,
                             "Viewport meta tag present."))

    # ---------------- Loading state ----------------
    max_loaders = 0
    loader_sample: List[str] = []
    for r in audit.get("viewport_reports", []):
        lv = r.get("loaders", {}).get("visible", 0)
        if lv > max_loaders:
            max_loaders = lv
            loader_sample = r.get("loaders", {}).get("sample", [])
    if max_loaders > 0:
        checks.append(_check("Loading", "Stuck loaders / skeletons", WARN,
                             f"{max_loaders} loading indicator(s) still visible after the page settled "
                             "— possible infinite spinner or failed data fetch.",
                             evidence=loader_sample[:5], weight=1.2))
    else:
        checks.append(_check("Loading", "Stuck loaders / skeletons", PASS,
                             "No lingering spinners or skeletons after load."))

    # ---------------- Responsive ----------------
    n_vp = len(audit.get("viewport_reports", []))
    if n_vp >= 2:
        clean = sum(1 for r in audit.get("viewport_reports", [])
                    if r.get("overflow", {}).get("overflowPx", 0) <= 4)
        if clean == n_vp:
            checks.append(_check("Responsive", "Multi-viewport layout", PASS,
                                 f"Layout is clean across all {n_vp} viewports tested."))
        else:
            checks.append(_check("Responsive", "Multi-viewport layout", WARN,
                                 f"{n_vp - clean}/{n_vp} viewport(s) show layout problems.",
                                 weight=1.0))

    # ---------------- Content & SEO ----------------
    meta = first.get("meta", {})
    if meta.get("title"):
        checks.append(_check("Content & SEO", "Page title", PASS, f"“{meta['title'][:70]}”"))
    else:
        checks.append(_check("Content & SEO", "Page title", WARN, "No <title> set.", weight=1.0))
    if meta.get("description"):
        checks.append(_check("Content & SEO", "Meta description", PASS, "Present."))
    else:
        checks.append(_check("Content & SEO", "Meta description", INFO, "No meta description."))
    if not meta.get("hasFavicon", True):
        checks.append(_check("Content & SEO", "Favicon", INFO, "No favicon linked."))
    if meta.get("h1Count", 1) == 0:
        checks.append(_check("Content & SEO", "Heading structure", WARN,
                             "No <h1> on the page.", weight=0.5))

    # ---------------- Accessibility ----------------
    uc = first.get("a11y", {}).get("unlabeledControls", 0)
    ui = first.get("a11y", {}).get("unlabeledInputs", 0)
    if missing_alt:
        checks.append(_check("Accessibility", "Image alt text", WARN,
                             f"{missing_alt} image(s) missing alt text.", weight=0.5))
    if uc:
        checks.append(_check("Accessibility", "Accessible control names", WARN,
                             f"{uc} button/link(s) have no accessible name.", weight=0.5))
    if ui:
        checks.append(_check("Accessibility", "Form labels", WARN,
                             f"{ui} form input(s) have no label.", weight=0.5))
    if not (missing_alt or uc or ui):
        checks.append(_check("Accessibility", "Basic accessibility", PASS,
                             "No obvious accessibility gaps in the quick scan."))

    return _assemble(audit, checks)


def _assemble(audit: Dict[str, Any], checks: List[Dict[str, Any]]) -> Dict[str, Any]:
    # Per-category penalty, normalized against that category's worst-case.
    cat_penalty: Dict[str, float] = {}
    cat_max: Dict[str, float] = {}
    for c in checks:
        cat = c["category"]
        cat_penalty[cat] = cat_penalty.get(cat, 0.0) + _STATUS_PENALTY[c["status"]] * c["weight"]
        cat_max[cat] = cat_max.get(cat, 0.0) + c["weight"]

    score = 100.0
    category_scores: Dict[str, Any] = {}
    for cat, weight in _CATEGORY_WEIGHTS.items():
        if cat not in cat_max or cat_max[cat] == 0:
            category_scores[cat] = {"score": 100, "status": PASS, "present": cat in cat_penalty}
            continue
        frac = min(1.0, cat_penalty[cat] / cat_max[cat])
        deduction = frac * weight
        score -= deduction
        cscore = round(100 * (1 - frac))
        cstatus = PASS if cscore >= 85 else (WARN if cscore >= 55 else FAIL)
        category_scores[cat] = {"score": cscore, "status": cstatus, "present": True}

    score = max(0, round(score))
    if not audit.get("reachable"):
        score = 0

    fails = sum(1 for c in checks if c["status"] == FAIL)
    warns = sum(1 for c in checks if c["status"] == WARN)

    if score >= 90 and fails == 0:
        verdict, grade_letter = "Healthy", "A"
    elif score >= 75:
        verdict, grade_letter = "Minor issues", "B"
    elif score >= 55:
        verdict, grade_letter = "Needs attention", "C"
    elif score >= 35:
        verdict, grade_letter = "Serious problems", "D"
    else:
        verdict, grade_letter = "Critical", "F"

    return {
        "score": score,
        "grade": grade_letter,
        "verdict": verdict,
        "fails": fails,
        "warns": warns,
        "checks": checks,
        "category_scores": category_scores,
    }


def _first_report(audit: Dict[str, Any]) -> Dict[str, Any]:
    reps = audit.get("viewport_reports", [])
    return reps[0] if reps else {}


def _is_hydration(msg: str) -> bool:
    low = msg.lower()
    needles = ["hydrat", "did not match", "text content does not match",
               "minified react error", "cannot read properties of undefined",
               "is not a function", "unhandled", "chunkloaderror", "loading chunk"]
    return any(n in low for n in needles)
