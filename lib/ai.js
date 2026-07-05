// Optional OpenAI-vision review of the captured screenshots.
// Uses the OPENAI_API_KEY set in the Vercel project's environment variables.
import OpenAI from 'openai';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

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
If the specifics list is empty, return an empty feature_verdicts array.`;

export function aiConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

export async function aiReview(audit, features) {
  if (!process.env.OPENAI_API_KEY) {
    return { available: false, reason: 'No OPENAI_API_KEY configured in the environment.' };
  }

  const shots = (audit.screenshots || []).filter((s) => s.b64).slice(0, 3);
  if (!shots.length) return { available: false, reason: 'No screenshots available to analyze.' };

  const content = [];
  for (const s of shots) {
    content.push({ type: 'text', text: `Screenshot — ${s.name} (${s.width}x${s.height}):` });
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${s.b64}`, detail: 'low' } });
  }
  const digest = (audit.page_text || '').slice(0, 1500);
  const featTxt = (features || []).filter(Boolean).map((f) => `- ${f}`).join('\n') || '(none provided)';
  content.push({
    type: 'text',
    text: `URL under test: ${audit.url}\n\nVisible-text digest:\n${digest}\n\nSpecifics the owner wants watched for:\n${featTxt}\n\n${SCHEMA_HINT}`,
  });

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '';
    const data = safeParse(raw);
    if (!data) return { available: true, error: 'Could not parse model response.', raw: raw.slice(0, 600) };
    return { available: true, model: MODEL, ...data };
  } catch (e) {
    return { available: false, reason: `${e.name || 'Error'}: ${e.message || e}` };
  }
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch (e) { /* fall through */ }
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { /* noop */ } }
  return null;
}
