// GET /api/version — reports the running build so you can confirm a deploy is live.
// The commit comes from Vercel's build-time env, so it reflects the actual
// deployed code even if the browser cached an older index.html.
export const UI_VERSION = '1.4.1';

export default function handler(req, res) {
  res.status(200).json({
    version: UI_VERSION,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'local',
    env: process.env.VERCEL_ENV || 'dev',
  });
}
