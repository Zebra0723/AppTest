// GET /api/version — reports the running build so you can confirm a deploy is live.
// The commit comes from Vercel's build-time env, so it reflects the actual
// deployed code even if the browser cached an older index.html. `node` reports
// the runtime Node version — it MUST be 20.x on Vercel (Node 22 is missing the
// system libraries Chromium needs, causing libnss3.so errors).
export const UI_VERSION = '1.4.6';

export default function handler(req, res) {
  res.status(200).json({
    version: UI_VERSION,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'local',
    env: process.env.VERCEL_ENV || 'dev',
    node: process.version,
  });
}
