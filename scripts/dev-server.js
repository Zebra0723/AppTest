// Local dev server that mirrors Vercel's routing: serves /public statically and
// dispatches POST /api/test to the same handler Vercel runs. For local use only.
//
//   LOCAL_CHROME_PATH=/path/to/chrome node scripts/dev-server.js
//
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import testHandler from '../api/test.js';
import versionHandler from '../api/version.js';

const API = { '/api/test': testHandler, '/api/version': versionHandler };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (API[u.pathname]) {
    // Adapt Node's res to the Express-ish API the handlers expect.
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    try { await API[u.pathname](req, res); }
    catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
    return;
  }

  // static
  let file = u.pathname === '/' ? '/index.html' : u.pathname;
  const candidates = [path.join(ROOT, 'public', file), path.join(ROOT, file.replace(/^\//, ''))];
  for (const p of candidates) {
    try {
      const data = await readFile(p);
      res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
      res.end(data);
      return;
    } catch (e) { /* try next */ }
  }
  res.statusCode = 404; res.end('Not found');
});

server.listen(PORT, () => console.log(`dev server on http://127.0.0.1:${PORT}`));
