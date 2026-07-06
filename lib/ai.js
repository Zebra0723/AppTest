// Optional vision review of the captured screenshots.
//
// Provider is auto-detected from whichever API key is present, preferring the
// FREE options first so no billing is required:
//   1. Google Gemini   — GEMINI_API_KEY (or GOOGLE_API_KEY). FREE tier at
//                         https://aistudio.google.com/apikey (no credit card).
//   2. Groq            — GROQ_API_KEY. Free tier, OpenAI-compatible.
//   3. OpenAI          — OPENAI_API_KEY. Paid.
//
// All calls use plain fetch (Node 20 global) — no SDK dependency.

const SYSTEM = [
  'You are a meticulous QA engineer reviewing screenshots of a freshly deployed web app.',
  'You are given screenshots at one or more viewport sizes, a short digest of the page\'s visible text,',
  'and a list of specifics the owner wants watched for. Judge ONLY from the evidence provided.',
  'Be concrete and specific; cite what you actually see. Do not invent problems that are not visible.',
  'Respond with a single JSON object matching the requested schema.',
].join(' ');

const SCHEMA_HINT = `Return JSON exactly in this shape:
{
  "overall_impression": "one or two sentences on how the page looks",
  "looks_broken": true|false,
  "visual_bugs": [ { "severity": "high|medium|low", "issue": "...", "where": "which viewport/area" } ],
  "feature_verdicts": [ { "feature": "<echo the specific>", "status": "present|partial|missing|broken", "evidence": "what in the screenshot supports this" } ]
}
If the specifics list is empty, return an empty feature_verdicts array. Output only the JSON, no prose.`;

function geminiKey() { return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY; }

function pickProvider() {
  if (geminiKey()) return 'gemini';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

export function aiConfigured() {
  return !!pickProvider();
}

export async function aiReview(audit, features) {
  const provider = pickProvider();
  if (!provider) {
    return {
      available: false,
      reason: 'No AI key set. Add a FREE Gemini key as GEMINI_API_KEY ' +
        '(get one at https://aistudio.google.com/apikey — no billing needed).',
    };
  }

  const shots = (audit.screenshots || []).filter((s) => s.b64).slice(0, 3);
  if (!shots.length) return { available: false, reason: 'No screenshots available to analyze.' };

  const digest = (audit.page_text || '').slice(0, 1500);
  const featTxt = (features || []).filter(Boolean).map((f) => `- ${f}`).join('\n') || '(none provided)';
  const userText = `URL under test: ${audit.url}\n\nVisible-text digest:\n${digest}\n\n` +
    `Specifics the owner wants watched for:\n${featTxt}\n\n${SCHEMA_HINT}`;

  try {
    if (provider === 'gemini') return await runGemini(shots, userText);
    return await runOpenAICompatible(provider, shots, userText);
  } catch (e) {
    return { available: false, reason: `${e.name || 'Error'}: ${e.message || e}` };
  }
}

// ---- Google Gemini (free) ---------------------------------------------------
async function runGemini(shots, userText) {
  const key = geminiKey();
  const parts = [];
  for (const s of shots) {
    parts.push({ text: `Screenshot — ${s.name} (${s.width}x${s.height}):` });
    parts.push({ inline_data: { mime_type: 'image/png', data: s.b64 } });
  }
  parts.push({ text: userText });
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1600, temperature: 0.2 },
  });

  // Try a sequence of free-tier models — the newest ones can 429 on a fresh key,
  // while the lighter flash models have generous free quota. Respect an explicit
  // GEMINI_MODEL override.
  const models = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL]
    : ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'];

  let lastErr = '';
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch (e) {
      lastErr = `${model}: ${e.message || e}`;
      continue;
    }
    if (resp.ok) {
      const json = await resp.json();
      const raw = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      const data = safeParse(raw);
      if (!data) return { available: true, model, error: 'Could not parse model response.', raw: raw.slice(0, 600) };
      return { available: true, model: `${model} (Gemini, free)`, ...data };
    }
    const bodyText = await resp.text().catch(() => '');
    lastErr = `${model} → ${resp.status}`;
    // A bad/blocked key won't be fixed by trying another model.
    if (resp.status === 401 || resp.status === 403) {
      return { available: false, reason: `Gemini rejected the key (${resp.status}). Check GEMINI_API_KEY.` };
    }
    // 429 (quota) / 404 (model not available) → try the next model.
  }
  return {
    available: false,
    reason: `Gemini free quota/model unavailable (last: ${lastErr}). ` +
      `The free quota may be temporarily used up for this key — retry shortly, ` +
      `or add a free GROQ_API_KEY instead.`,
  };
}

// ---- OpenAI-compatible (Groq free, or OpenAI paid) --------------------------
async function runOpenAICompatible(provider, shots, userText) {
  const cfg = provider === 'groq'
    ? {
        key: process.env.GROQ_API_KEY,
        base: 'https://api.groq.com/openai/v1',
        model: process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
        label: 'Groq, free',
      }
    : {
        key: process.env.OPENAI_API_KEY,
        base: 'https://api.openai.com/v1',
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        label: 'OpenAI',
      };

  const content = [];
  for (const s of shots) {
    content.push({ type: 'text', text: `Screenshot — ${s.name} (${s.width}x${s.height}):` });
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${s.b64}` } });
  }
  content.push({ type: 'text', text: userText });

  const resp = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1400,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { available: false, reason: `${cfg.label} API ${resp.status}: ${body.slice(0, 200)}` };
  }
  const json = await resp.json();
  const raw = json.choices?.[0]?.message?.content || '';
  const data = safeParse(raw);
  if (!data) return { available: true, model: cfg.model, error: 'Could not parse model response.', raw: raw.slice(0, 600) };
  return { available: true, model: `${cfg.model} (${cfg.label})`, ...data };
}

function safeParse(raw) {
  raw = String(raw || '').trim();
  if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch (e) { /* fall through */ }
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { /* noop */ } }
  return null;
}
