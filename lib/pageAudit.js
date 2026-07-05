// Functions that run *inside the page under test* (passed to page.evaluate).
// Kept in their own module so they read as ordinary browser code.

/** Snapshot the DOM for one viewport: overflow, images, content, meta, loaders, a11y. */
export function pageAudit() {
  const docEl = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // --- horizontal overflow (the classic mobile bug) ---
  const scrollW = Math.max(docEl.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const overflowPx = scrollW - vw;
  const offenders = [];
  if (overflowPx > 2) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 2) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 60),
          right: Math.round(r.right),
        });
        if (offenders.length >= 8) break;
      }
    }
  }

  // --- images ---
  const imgs = Array.from(document.images || []);
  const broken = [];
  let missingAlt = 0;
  for (const im of imgs) {
    if (im.complete && im.naturalWidth === 0 && broken.length < 8) {
      broken.push(im.currentSrc || im.src || '(inline)');
    }
    if (!im.alt || !im.alt.trim()) missingAlt++;
  }

  // --- visible text / blankness ---
  const bodyText = (document.body ? document.body.innerText : '') || '';
  const trimmed = bodyText.replace(/\s+/g, ' ').trim();

  // --- meta / SEO ---
  const metaDesc = document.querySelector('meta[name="description"]');
  const q = (s) => document.querySelector(s);

  // --- stuck loaders / skeletons visible after settle ---
  const loaderSelectors = [
    '[class*="spinner" i]', '[class*="loader" i]', '[class*="loading" i]',
    '[class*="skeleton" i]', '[aria-busy="true"]', '[role="progressbar"]', '.animate-pulse',
  ];
  let visibleLoaders = 0;
  const loaderSample = [];
  for (const sel of loaderSelectors) {
    let nodes = [];
    try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      const shown = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' &&
        cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05;
      if (shown) {
        visibleLoaders++;
        if (loaderSample.length < 5) {
          loaderSample.push(sel + (n.className ? ' .' + n.className.toString().slice(0, 40) : ''));
        }
      }
    }
  }

  // --- basic accessibility ---
  let unlabeledControls = 0;
  const controls = document.querySelectorAll('button, a[href], [role="button"]');
  for (const c of controls) {
    const name = (c.innerText || '').trim() || c.getAttribute('aria-label') ||
      c.getAttribute('title') || (c.querySelector('img[alt]') ? c.querySelector('img[alt]').alt : '');
    if (!name || !name.trim()) unlabeledControls++;
  }
  let unlabeledInputs = 0;
  const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
  for (const inp of inputs) {
    const id = inp.getAttribute('id');
    const hasLabel = (id && document.querySelector('label[for="' + (window.CSS ? CSS.escape(id) : id) + '"]')) ||
      inp.closest('label') || inp.getAttribute('aria-label') ||
      inp.getAttribute('aria-labelledby') || inp.getAttribute('placeholder');
    if (!hasLabel) unlabeledInputs++;
  }

  return {
    viewport: { w: vw, h: vh },
    overflow: { scrollWidth: scrollW, overflowPx: Math.max(0, overflowPx), offenders },
    images: { total: imgs.length, broken, missingAlt },
    content: { textLen: trimmed.length, elements: document.querySelectorAll('body *').length, sample: trimmed.slice(0, 500) },
    meta: {
      title: (document.title || '').trim(),
      description: metaDesc ? (metaDesc.getAttribute('content') || '').trim() : null,
      hasViewportMeta: !!q('meta[name="viewport"]'),
      hasFavicon: !!q('link[rel~="icon"], link[rel="shortcut icon"]'),
      hasOgTitle: !!q('meta[property="og:title"]'),
      hasOgImage: !!q('meta[property="og:image"]'),
      lang: docEl.getAttribute('lang') || null,
      h1Count: document.querySelectorAll('h1').length,
    },
    loaders: { visible: visibleLoaders, sample: loaderSample },
    a11y: { unlabeledControls, unlabeledInputs },
  };
}

/** Score how present a declared feature is by fuzzy-matching its key words. */
export function featureProbe(feature) {
  const words = String(feature).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (!words.length) return { matched: 0, total: 0 };
  const attrs = Array.from(document.querySelectorAll('[aria-label],[placeholder],[alt],[title],button,a'))
    .map((e) => [e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('alt'),
      e.getAttribute('title'), e.innerText].filter(Boolean).join(' ')).join(' ');
  const text = ((document.body ? document.body.innerText : '') + ' ' + attrs).toLowerCase();
  let hit = 0;
  for (const w of words) if (text.includes(w)) hit++;
  return { matched: hit, total: words.length };
}
