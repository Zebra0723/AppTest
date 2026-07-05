"""
VercelCheck — a bot that tests your Vercel deployments.

Give it a deployment URL and a plain-English description of what the app should
include. It drives a real headless browser against the site and checks
everything from common layout/loading bugs (horizontal overflow, broken images,
stuck spinners, console/JS crashes, failed requests, missing responsive meta) to
the niche, app-specific features you list — optionally confirmed by Claude
looking at the actual screenshots.

Run it with:  streamlit run streamlit_app.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from urllib.parse import urlparse

import streamlit as st

from vercel_bot import ai, engine, scoring, styles

ROOT = os.path.dirname(os.path.abspath(__file__))


@st.cache_resource(show_spinner="Preparing headless browser (first run only)…")
def _bootstrap_browser() -> bool:
    """Ensure Chromium is installed once per container (e.g. Streamlit Cloud)."""
    return engine.ensure_chromium()

st.set_page_config(page_title="VercelCheck — deployment tester",
                   page_icon="🛰️", layout="centered")
st.markdown(styles.CSS, unsafe_allow_html=True)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def normalize_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    return raw


def valid_url(u: str) -> bool:
    try:
        p = urlparse(u)
        return bool(p.scheme in ("http", "https") and p.netloc)
    except Exception:
        return False


def run_engine(url: str, features: list, viewports: list, wait_ms: int) -> dict:
    """Run the Playwright engine in a subprocess (keeps Playwright's sync API
    away from Streamlit's event loop) and return the parsed audit dict."""
    workdir = tempfile.mkdtemp(prefix="vercelcheck_")
    cfg_path = os.path.join(workdir, "config.json")
    res_path = os.path.join(workdir, "result.json")
    config = {
        "url": url,
        "features": features,
        "viewports": viewports,
        "wait_extra_ms": wait_ms,
        "outdir": os.path.join(workdir, "shots"),
        "result_path": res_path,
    }
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump(config, fh)

    proc = subprocess.run(
        [sys.executable, "-m", "vercel_bot.engine", cfg_path],
        cwd=ROOT, capture_output=True, text=True, timeout=180,
    )
    if os.path.exists(res_path):
        with open(res_path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    # Fall back to stdout, else surface the failure.
    out = (proc.stdout or "").strip()
    if out:
        try:
            return json.loads(out.splitlines()[-1])
        except Exception:
            pass
    return {"reachable": False, "ok": False,
            "error": (proc.stderr or "Engine produced no output.")[:600],
            "metrics": {}, "viewport_reports": [], "screenshots": [],
            "console": {"errors": [], "warnings": []}, "page_errors": [],
            "network": {"failed": [], "bad_status": []}, "features": []}


VIEWPORT_PRESETS = {
    "Desktop": {"name": "Desktop", "width": 1440, "height": 900},
    "Tablet": {"name": "Tablet", "width": 768, "height": 1024},
    "Mobile": {"name": "Mobile", "width": 390, "height": 844},
}


# --------------------------------------------------------------------------- #
# Header + input
# --------------------------------------------------------------------------- #
st.markdown(
    '<div class="vc-brand"><div class="vc-logo"></div>'
    '<div class="vc-title">VercelCheck</div></div>'
    '<div class="vc-sub">Point it at any deployment, tell it what the app should '
    'include, and it hunts for layout, loading and feature bugs — with a real browser.</div>',
    unsafe_allow_html=True,
)

with st.form("run"):
    url_in = st.text_input(
        "Deployment URL",
        placeholder="my-app.vercel.app  or  https://my-app-git-main.vercel.app",
    )
    features_in = st.text_area(
        "What should this deployment include?",
        placeholder=(
            "One expectation per line, e.g.:\n"
            "Hero section with a “Get started” call to action\n"
            "Working search bar in the header\n"
            "Dark mode toggle\n"
            "Pricing table with three tiers\n"
            "Contact form that submits"
        ),
        height=150,
        help="Plain English. Each line becomes a feature the bot looks for on the page.",
    )

    c1, c2 = st.columns([3, 2])
    with c1:
        chosen_vps = st.multiselect(
            "Viewports to test", list(VIEWPORT_PRESETS.keys()),
            default=["Desktop", "Mobile"],
        )
    with c2:
        wait_s = st.slider("Settle time (s)", 1, 8, 3,
                           help="How long to wait after load for SPA data/hydration.")

    with st.expander("AI visual review (optional) & advanced"):
        use_ai = st.checkbox(
            "Use Claude to visually verify features from the screenshots", value=False)
        api_key = st.text_input(
            "Anthropic API key",
            value=os.environ.get("ANTHROPIC_API_KEY", ""),
            type="password",
            help="Only needed for the AI review. Read from ANTHROPIC_API_KEY if set.",
        )
        st.caption("Heuristic checks always run. The AI layer adds a screenshot-based "
                   "visual review and smarter per-feature verdicts.")

    submitted = st.form_submit_button("Run test  ▶", use_container_width=True)


# --------------------------------------------------------------------------- #
# Run
# --------------------------------------------------------------------------- #
if submitted:
    url = normalize_url(url_in)
    if not valid_url(url):
        st.error("Please enter a valid URL (e.g. my-app.vercel.app).")
        st.stop()

    features = [ln.strip() for ln in (features_in or "").splitlines() if ln.strip()]
    viewports = [VIEWPORT_PRESETS[v] for v in (chosen_vps or ["Desktop"])]

    _bootstrap_browser()
    with st.status("Testing deployment…", expanded=True) as status:
        st.write(f"Launching headless Chromium against **{url}**")
        try:
            audit = run_engine(url, features, viewports, int(wait_s * 1000))
        except subprocess.TimeoutExpired:
            status.update(label="Timed out", state="error")
            st.error("The test timed out after 180s — the site may be very slow or unresponsive.")
            st.stop()

        report = scoring.grade(audit)
        st.write(f"Ran **{len(report['checks'])}** checks across "
                 f"**{len(audit.get('viewport_reports', []))}** viewport(s).")

        ai_result = None
        if use_ai and audit.get("reachable"):
            if ai.is_available(api_key):
                st.write("Asking Claude to review the screenshots…")
                ai_result = ai.analyze(audit, features, api_key=api_key or None)
            else:
                st.write("_AI review skipped — no valid API key / package._")

        status.update(label="Test complete", state="complete", expanded=False)

    st.session_state["last"] = {"audit": audit, "report": report, "ai": ai_result,
                                "features": features}


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #
data = st.session_state.get("last")
if data:
    audit = data["audit"]
    report = data["report"]
    ai_result = data.get("ai")
    features = data.get("features", [])

    if not audit.get("reachable"):
        st.error(f"Could not load the deployment. {audit.get('error','')}")

    # Hero score
    st.markdown(
        styles.score_ring(report["score"], report["grade"], report["verdict"],
                          report["fails"], report["warns"], audit.get("metrics", {})),
        unsafe_allow_html=True,
    )

    # Category grid
    st.markdown('<div class="vc-section-title">Category scores</div>', unsafe_allow_html=True)
    st.markdown(styles.category_grid(report["category_scores"]), unsafe_allow_html=True)

    # Screenshots
    shots = audit.get("screenshots", [])
    if shots:
        st.markdown('<div class="vc-section-title">Screenshots</div>', unsafe_allow_html=True)
        tabs = st.tabs([f"{s['name']} · {s['width']}×{s['height']}" for s in shots])
        for tab, shot in zip(tabs, shots):
            with tab:
                if shot.get("path") and os.path.exists(shot["path"]):
                    st.image(shot["path"], use_container_width=True)
                else:
                    st.caption("Screenshot unavailable.")

    # AI visual review
    if ai_result and ai_result.get("available"):
        st.markdown('<div class="vc-section-title">AI visual review</div>', unsafe_allow_html=True)
        impression = ai_result.get("overall_impression")
        if impression:
            broken = ai_result.get("looks_broken")
            tone = "🔴" if broken else "🟢"
            st.markdown(f'<div class="vc-card">{tone} {styles._esc(impression)}</div>',
                        unsafe_allow_html=True)
        bugs = ai_result.get("visual_bugs") or []
        if bugs:
            rows = "".join(styles.visual_bug_row(b) for b in bugs)
            st.markdown(f'<div class="vc-card">{rows}</div>', unsafe_allow_html=True)
        else:
            st.caption("Claude found no obvious visual bugs in the screenshots.")
    elif ai_result and ai_result.get("reason"):
        st.info(f"AI review unavailable: {ai_result['reason']}")

    # Feature checklist (merge heuristic + AI verdicts)
    if features:
        st.markdown('<div class="vc-section-title">Expected features</div>', unsafe_allow_html=True)
        ai_map = {}
        if ai_result and ai_result.get("available"):
            for fv in ai_result.get("feature_verdicts", []) or []:
                ai_map[(fv.get("feature") or "").strip().lower()] = fv
        rows = []
        for f in audit.get("features", []):
            fv = ai_map.get(f["feature"].strip().lower(), {})
            rows.append(styles.feature_row(
                f["feature"], f["status"], f["note"],
                ai_status=fv.get("status", ""), ai_evidence=fv.get("evidence", "")))
        st.markdown(f'<div class="vc-card">{"".join(rows)}</div>', unsafe_allow_html=True)

    # Detailed checks by category
    st.markdown('<div class="vc-section-title">Detailed checks</div>', unsafe_allow_html=True)
    by_cat: dict = {}
    for c in report["checks"]:
        by_cat.setdefault(c["category"], []).append(c)
    for cat, items in by_cat.items():
        worst = "pass"
        for it in items:
            if it["status"] == "fail":
                worst = "fail"
                break
            if it["status"] == "warn" and worst != "fail":
                worst = "warn"
        head = f"{cat} — {len([i for i in items if i['status']=='fail'])} fail · " \
               f"{len([i for i in items if i['status']=='warn'])} warn"
        with st.expander(head, expanded=(worst == "fail")):
            rows = "".join(styles.check_row(c) for c in items)
            st.markdown(f'<div>{rows}</div>', unsafe_allow_html=True)

    # Raw data
    with st.expander("Raw audit data (JSON)"):
        st.json({"metrics": audit.get("metrics", {}),
                 "console": audit.get("console", {}),
                 "page_errors": audit.get("page_errors", []),
                 "network": audit.get("network", {})})
else:
    st.markdown(
        '<div class="vc-card" style="color:#64748b">'
        "👋 Enter a deployment URL above and list what it should include, then hit "
        "<b>Run test</b>. VercelCheck opens the page in a real browser and checks "
        "loading, layout, responsiveness, console/network health, and each feature "
        "you named.</div>",
        unsafe_allow_html=True,
    )
