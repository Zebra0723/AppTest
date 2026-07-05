"""
Optional Claude-vision layer.

Given the captured screenshots, a short DOM text digest and the user's list of
expected features, ask Claude to (a) spot visual bugs a DOM audit can't see and
(b) give a per-feature verdict grounded in the screenshots.

Everything here is best-effort and optional: if no API key is configured, or the
call fails, the caller simply skips the AI section. The heuristic engine is the
source of truth; the AI is an enhancement.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Dict, List, Optional

# A capable, fast vision model. Overridable via env for cost/latency tuning.
DEFAULT_MODEL = os.environ.get("VERCELCHECK_AI_MODEL", "claude-sonnet-5")

_SYSTEM = (
    "You are a meticulous QA engineer reviewing screenshots of a freshly deployed "
    "web app. You are given screenshots at one or more viewport sizes, a short "
    "digest of the page's visible text, and a list of features/content the owner "
    "says the app SHOULD include. "
    "Judge only from the evidence provided. Be concrete and specific; cite what you "
    "see. Do not invent problems that aren't visible. Respond with a single JSON "
    "object and nothing else."
)

_SCHEMA_HINT = """
Return JSON exactly in this shape:
{
  "overall_impression": "one or two sentences on how the page looks",
  "looks_broken": true|false,
  "visual_bugs": [
    {"severity": "high|medium|low", "issue": "...", "where": "which viewport/area"}
  ],
  "feature_verdicts": [
    {"feature": "<echo the feature>", "status": "present|partial|missing|broken",
     "evidence": "what in the screenshot supports this"}
  ]
}
If a features list is empty, return an empty feature_verdicts array.
""".strip()


def is_available(api_key: Optional[str] = None) -> bool:
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return False
    try:
        import anthropic  # noqa: F401
    except Exception:
        return False
    return True


def _img_block(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except Exception:
        return None
    if not data:
        return None
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.standard_b64encode(data).decode("ascii"),
        },
    }


def analyze(audit: Dict[str, Any], features: List[str],
            api_key: Optional[str] = None,
            model: str = DEFAULT_MODEL) -> Dict[str, Any]:
    """Run the vision analysis. Returns {"available": bool, ...}."""
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return {"available": False, "reason": "No ANTHROPIC_API_KEY configured."}
    try:
        import anthropic
    except Exception:
        return {"available": False, "reason": "anthropic package not installed."}

    content: List[Dict[str, Any]] = []
    # Attach up to 3 screenshots, labeled.
    for shot in audit.get("screenshots", [])[:3]:
        img = _img_block(shot["path"])
        if img:
            content.append({"type": "text",
                            "text": f"Screenshot — {shot['name']} ({shot['width']}x{shot['height']}):"})
            content.append(img)

    if not any(b.get("type") == "image" for b in content):
        return {"available": False, "reason": "No screenshots available to analyze."}

    digest = (audit.get("page_text") or "")[:1500]
    feat_txt = "\n".join(f"- {f}" for f in features if f.strip()) or "(none provided)"
    content.append({
        "type": "text",
        "text": (
            f"URL under test: {audit.get('url')}\n\n"
            f"Visible-text digest:\n{digest}\n\n"
            f"Features the owner says it SHOULD include:\n{feat_txt}\n\n"
            f"{_SCHEMA_HINT}"
        ),
    })

    try:
        client = anthropic.Anthropic(api_key=key)
        msg = client.messages.create(
            model=model,
            max_tokens=1600,
            system=_SYSTEM,
            messages=[{"role": "user", "content": content}],
        )
        raw = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        data = _parse_json(raw)
        if data is None:
            return {"available": True, "error": "Could not parse model response.",
                    "raw": raw[:800]}
        data["available"] = True
        data["model"] = model
        return data
    except Exception as e:  # network / auth / rate-limit
        return {"available": False, "reason": f"{type(e).__name__}: {e}"}


def _parse_json(raw: str) -> Optional[Dict[str, Any]]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
    try:
        return json.loads(raw)
    except Exception:
        start, end = raw.find("{"), raw.rfind("}")
        if 0 <= start < end:
            try:
                return json.loads(raw[start:end + 1])
            except Exception:
                return None
    return None
