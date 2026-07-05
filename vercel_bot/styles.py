"""Presentation helpers for the Streamlit UI: CSS + small HTML fragment builders.

Kept free of Streamlit imports so the fragments are trivially testable.
"""

from __future__ import annotations

import html
from typing import Dict, List

# Palette ------------------------------------------------------------------
INK = "#0f172a"
MUTED = "#64748b"
LINE = "#e7e9ee"
CARD = "#ffffff"
BG = "#f6f7f9"
INDIGO = "#6366f1"

STATUS_COLOR = {
    "pass": "#16a34a",
    "warn": "#d97706",
    "fail": "#dc2626",
    "info": "#64748b",
}
STATUS_BG = {
    "pass": "#e9f7ee",
    "warn": "#fdf3e3",
    "fail": "#fdeaea",
    "info": "#eef1f5",
}
STATUS_ICON = {"pass": "✓", "warn": "!", "fail": "✕", "info": "i"}
STATUS_LABEL = {"pass": "Pass", "warn": "Warn", "fail": "Fail", "info": "Info"}


def _score_color(score: int) -> str:
    if score >= 85:
        return STATUS_COLOR["pass"]
    if score >= 55:
        return STATUS_COLOR["warn"]
    return STATUS_COLOR["fail"]


CSS = f"""
<style>
  :root {{ --ink:{INK}; --muted:{MUTED}; --line:{LINE}; --indigo:{INDIGO}; }}

  /* Frame */
  .stApp {{ background:{BG}; }}
  .block-container {{ padding-top: 2.2rem; max-width: 1080px; }}
  #MainMenu, footer, header {{ visibility: hidden; }}

  html, body, [class*="css"] {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    color: var(--ink);
  }}

  /* Brand header */
  .vc-brand {{ display:flex; align-items:center; gap:.7rem; margin-bottom:.15rem; }}
  .vc-logo {{
    width:38px;height:38px;border-radius:11px;flex:0 0 auto;
    background: conic-gradient(from 210deg, #6366f1, #8b5cf6, #ec4899, #6366f1);
    box-shadow: 0 6px 18px rgba(99,102,241,.35);
  }}
  .vc-title {{ font-size:1.7rem; font-weight:750; letter-spacing:-.02em; line-height:1; }}
  .vc-sub {{ color:var(--muted); font-size:.95rem; margin: .1rem 0 1.4rem 0; }}

  /* Generic card */
  .vc-card {{
    background:{CARD}; border:1px solid var(--line); border-radius:16px;
    padding:18px 20px; box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }}

  /* Hero */
  .vc-hero {{ display:flex; gap:26px; align-items:center; }}
  .vc-ring {{ flex:0 0 auto; }}
  .vc-verdict {{ font-size:1.35rem; font-weight:700; letter-spacing:-.01em; }}
  .vc-verdict-sub {{ color:var(--muted); font-size:.92rem; margin-top:2px; }}
  .vc-stats {{ display:flex; gap:26px; margin-top:14px; flex-wrap:wrap; }}
  .vc-stat b {{ font-size:1.25rem; font-weight:700; display:block; line-height:1.1; }}
  .vc-stat span {{ color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }}

  /* Badge / pill */
  .vc-badge {{
    display:inline-flex; align-items:center; gap:6px; font-size:.74rem; font-weight:650;
    padding:3px 9px; border-radius:999px; line-height:1;
  }}
  .vc-dot {{ width:14px;height:14px;border-radius:50%;display:inline-flex;
            align-items:center;justify-content:center;color:#fff;font-size:.62rem;font-weight:800; }}

  /* Category grid */
  .vc-grid {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:12px; }}
  .vc-cat {{ background:{CARD}; border:1px solid var(--line); border-radius:13px; padding:13px 14px; }}
  .vc-cat-name {{ font-size:.82rem; color:var(--muted); font-weight:600; }}
  .vc-cat-score {{ font-size:1.5rem; font-weight:750; letter-spacing:-.02em; }}
  .vc-bar {{ height:6px; border-radius:99px; background:#eef0f4; margin-top:9px; overflow:hidden; }}
  .vc-bar > i {{ display:block; height:100%; border-radius:99px; }}

  /* Check rows */
  .vc-check {{ display:flex; gap:11px; padding:11px 2px; border-top:1px solid #f1f2f5; }}
  .vc-check:first-child {{ border-top:none; }}
  .vc-check-label {{ font-weight:620; font-size:.95rem; }}
  .vc-check-detail {{ color:var(--muted); font-size:.86rem; margin-top:1px; }}
  .vc-evi {{ background:#f8f9fb; border:1px solid var(--line); border-radius:9px;
           padding:7px 10px; margin-top:7px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
           font-size:.76rem; color:#475569; white-space:pre-wrap; word-break:break-all; }}

  /* Feature rows */
  .vc-feat {{ display:flex; align-items:flex-start; gap:11px; padding:11px 2px; border-top:1px solid #f1f2f5; }}
  .vc-feat:first-child {{ border-top:none; }}

  .vc-section-title {{ font-size:1.06rem; font-weight:720; margin: 26px 0 10px; letter-spacing:-.01em; }}
  .stTabs [data-baseweb="tab-list"] {{ gap: 4px; }}
</style>
"""


def _esc(s) -> str:
    return html.escape(str(s))


def _oneline(fragment: str) -> str:
    """Collapse an HTML fragment to a single line.

    Streamlit renders HTML via CommonMark, where a ``<div>`` block (type 6)
    ends at the first blank *or whitespace-only* line and any 4-space-indented
    line becomes a code block. Stripping each line and joining removes both
    hazards while leaving the HTML semantically identical.
    """
    return "".join(line.strip() for line in fragment.splitlines())


def score_ring(score: int, grade: str, verdict: str, fails: int, warns: int,
               metrics: Dict) -> str:
    color = _score_color(score)
    R = 52
    import math
    circ = 2 * math.pi * R
    frac = max(0.0, min(1.0, score / 100.0))
    dash = f"{circ * frac:.1f} {circ:.1f}"
    status = metrics.get("http_status") or "—"
    load = metrics.get("load_ms")
    load_txt = f"{load} ms" if load else "—"
    ring = f"""
    <div class="vc-ring">
      <svg width="132" height="132" viewBox="0 0 132 132">
        <circle cx="66" cy="66" r="{R}" fill="none" stroke="#eef0f4" stroke-width="12"/>
        <circle cx="66" cy="66" r="{R}" fill="none" stroke="{color}" stroke-width="12"
                stroke-linecap="round" stroke-dasharray="{dash}"
                transform="rotate(-90 66 66)"/>
        <text x="66" y="60" text-anchor="middle" font-size="34" font-weight="800"
              fill="{INK}">{score}</text>
        <text x="66" y="82" text-anchor="middle" font-size="12" fill="{MUTED}"
              letter-spacing="1">/ 100</text>
      </svg>
    </div>"""
    return _oneline(f"""
    <div class="vc-card">
      <div class="vc-hero">
        {ring}
        <div style="flex:1">
          <div class="vc-verdict">Grade {_esc(grade)} · {_esc(verdict)}</div>
          <div class="vc-verdict-sub">{_esc(metrics.get('final_url',''))}</div>
          <div class="vc-stats">
            <div class="vc-stat"><b style="color:{STATUS_COLOR['fail']}">{fails}</b><span>Failures</span></div>
            <div class="vc-stat"><b style="color:{STATUS_COLOR['warn']}">{warns}</b><span>Warnings</span></div>
            <div class="vc-stat"><b>{_esc(status)}</b><span>HTTP</span></div>
            <div class="vc-stat"><b>{_esc(load_txt)}</b><span>Load time</span></div>
          </div>
        </div>
      </div>
    </div>""")


def badge(status: str) -> str:
    c = STATUS_COLOR[status]
    bg = STATUS_BG[status]
    return (f'<span class="vc-badge" style="color:{c};background:{bg}">'
            f'<span class="vc-dot" style="background:{c}">{STATUS_ICON[status]}</span>'
            f'{STATUS_LABEL[status]}</span>')


def dot(status: str) -> str:
    c = STATUS_COLOR[status]
    return (f'<span class="vc-dot" style="background:{c};width:20px;height:20px;'
            f'font-size:.72rem">{STATUS_ICON[status]}</span>')


def category_grid(category_scores: Dict[str, Dict]) -> str:
    cards = []
    for name, info in category_scores.items():
        if not info.get("present"):
            continue
        sc = info["score"]
        col = _score_color(sc)
        cards.append(f"""
          <div class="vc-cat">
            <div class="vc-cat-name">{_esc(name)}</div>
            <div class="vc-cat-score" style="color:{col}">{sc}</div>
            <div class="vc-bar"><i style="width:{sc}%;background:{col}"></i></div>
          </div>""")
    return _oneline(f'<div class="vc-grid">{"".join(cards)}</div>')


def check_row(check: Dict) -> str:
    evi = ""
    if check.get("evidence"):
        items = "".join(f'<span style="display:block">• {_esc(e)}</span>'
                        for e in check["evidence"])
        evi = f'<div class="vc-evi">{items}</div>'
    return _oneline(f"""
    <div class="vc-check">
      <div>{dot(check['status'])}</div>
      <div style="flex:1">
        <div class="vc-check-label">{_esc(check['label'])}</div>
        <div class="vc-check-detail">{_esc(check['detail'])}</div>
        {evi}
      </div>
    </div>""")


def feature_row(feature: str, status: str, note: str, ai_status: str = "",
                ai_evidence: str = "") -> str:
    ai_html = ""
    if ai_status:
        ai_html = (f'<div class="vc-check-detail" style="margin-top:5px">'
                   f'<b style="color:{STATUS_COLOR.get(_norm(ai_status),MUTED)}">AI: {_esc(ai_status)}</b>'
                   f' — {_esc(ai_evidence)}</div>')
    return _oneline(f"""
    <div class="vc-feat">
      <div>{dot(status)}</div>
      <div style="flex:1">
        <div class="vc-check-label">{_esc(feature)}</div>
        <div class="vc-check-detail">{_esc(note)}</div>
        {ai_html}
      </div>
    </div>""")


def _norm(ai_status: str) -> str:
    s = (ai_status or "").lower()
    if s in ("present", "pass"):
        return "pass"
    if s in ("partial", "warn"):
        return "warn"
    if s in ("missing", "broken", "fail"):
        return "fail"
    return "info"


def visual_bug_row(bug: Dict) -> str:
    sev = (bug.get("severity") or "medium").lower()
    smap = {"high": "fail", "medium": "warn", "low": "info"}
    status = smap.get(sev, "warn")
    where = bug.get("where", "")
    where_html = f'<div class="vc-check-detail">Where: {_esc(where)}</div>' if where else ""
    return _oneline(f"""
    <div class="vc-check">
      <div>{dot(status)}</div>
      <div style="flex:1">
        <div class="vc-check-label">{_esc(bug.get('issue',''))}</div>
        {where_html}
      </div>
    </div>""")
