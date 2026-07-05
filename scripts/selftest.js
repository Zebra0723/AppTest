// Exercise the audit + grading against the local sample site.
//   LOCAL_CHROME_PATH=/path/to/chrome node scripts/selftest.js [url]
import { runAudit } from '../lib/runAudit.js';
import { grade } from '../lib/grade.js';

const url = process.argv[2] || 'http://127.0.0.1:8770/';
const features = ['Search bar for notes', 'Dark mode toggle', 'Create a new note', 'Export notes to PDF'];

const audit = await runAudit({
  url, features,
  viewports: [
    { name: 'Desktop', width: 1440, height: 900 },
    { name: 'Mobile', width: 390, height: 844 },
  ],
  waitExtraMs: 1500,
});

console.log('reachable:', audit.reachable, '| status:', audit.metrics.http_status, '| load:', audit.metrics.load_ms, 'ms');
console.log('console errors:', audit.console.errors);
console.log('bad status:', audit.network.bad_status);
console.log('screenshots:', audit.screenshots.map(s => `${s.name}(${s.b64 ? s.b64.length : 0}b64)`));
for (const r of audit.viewport_reports) {
  console.log(` ${r.name}: overflow ${r.overflow.overflowPx}px | brokenImgs ${r.images.broken.length} | loaders ${r.loaders.visible} | viewportMeta ${r.meta.hasViewportMeta}`);
}
console.log('features:');
for (const f of audit.features) console.log(`  [${f.status}] ${f.feature} (${f.matched_terms}/${f.total_terms})`);

const rep = grade(audit);
console.log(`\nSCORE ${rep.score} grade ${rep.grade} · ${rep.verdict} | ${rep.fails} fail ${rep.warns} warn`);
for (const c of rep.checks) console.log(`  [${c.status.toUpperCase().padEnd(4)}] ${c.category.padEnd(14)} ${c.label}: ${c.detail.slice(0, 64)}`);
