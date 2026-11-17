// Shared page inventory for baseline.mjs and regress.mjs: what a rendered page has (links, nav,
// forms and fields, headings, buttons, images, ids, title, errors) and how a later build differs.
//   watchErrors(page)                      collects { page_errors, console_errors } (attach before goto)
//   extractInventory(page, errors?)        reads the DOM of a loaded Playwright page
//   inventoryOfUrl(browser, url, vp?)      opens a fresh context, loads the URL, returns { inventory, status }
//   isWaivedBy(lines, value, kind)         true when a KEEP.md line names the value (kind 'href'/'action' or text)
//   diffInventory(base, now, waivedLines)  returns [{ severity: 'error' | 'warning', kind, message }]

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = (s) => clean(s).toLowerCase();
const words = (x) => String(x ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const uniq = (arr, key = (x) => x) => {
  const seen = new Set();
  return (arr || []).filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
};

// Path form of a path or URL: origin, query-free path without index.html or a trailing slash.
// Same-origin hrefs and form actions are stored in this form ('/pricing', '/api/contact?x=1').
function normPath(p) {
  let s = String(p || '/').replace(/\/index\.html?$/i, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '') || '/';
  return s || '/';
}

function hrefKey(h) {
  const s = String(h ?? '').trim();
  let path;
  let query = '';
  if (/^https?:\/\//i.test(s)) {
    try { const u = new URL(s); path = u.pathname; query = u.search; } catch { return s; }
  } else if (s.startsWith('/')) {
    const m = s.match(/^([^?#]*)(\?[^#]*)?/);
    path = m[1]; query = m[2] || '';
  } else {
    return s;
  }
  return normPath(path) + query;
}

// Error text without URLs and line:col positions, so the same error on two builds compares equal.
function cleanError(s) {
  return clean(String(s ?? '')
    .replace(/\b(?:https?|file|blob|data):\/\/[^\s()'"<>]+/gi, ' ')
    .replace(/:\d+:\d+\b/g, ' ')
    .replace(/\bline \d+(?::\d+)?\b/gi, ' ')
    .replace(/\(\s*\)/g, ' ')).slice(0, 300);
}

export function watchErrors(page) {
  const errors = { page_errors: [], console_errors: [] };
  page.on('console', (m) => { if (m.type() === 'error') errors.console_errors.push(m.text()); });
  page.on('pageerror', (e) => errors.page_errors.push(e.message));
  return errors;
}

// Reads the inventory of a loaded page. The page is scrolled once (top to bottom, then back up)
// so lazy content and scroll reveals are in the DOM before it is read.
// errors: { page_errors, console_errors } from watchErrors (a plain array counts as console errors).
export async function extractInventory(page, errors = {}) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const max = Math.min(document.documentElement.scrollHeight, 30000);
    for (let y = 0; y < max; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
  });

  const raw = await page.evaluate(() => {
    const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const textOf = (el) => clean(el.getAttribute('aria-label') || el.textContent || el.value || '');
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return clean(l.textContent);
      }
      const wrap = el.closest('label');
      if (wrap) return clean(wrap.textContent);
      return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
    };
    const skipType = ['hidden', 'submit', 'button', 'image', 'reset'];
    return {
      title: clean(document.title),
      meta_description: clean(document.querySelector('meta[name="description"]')?.getAttribute('content') || ''),
      headings: [...document.querySelectorAll('h1,h2,h3')]
        .map((h) => ({ level: Number(h.tagName[1]), text: textOf(h) })).filter((h) => h.text),
      links: [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: textOf(a) })),
      nav: [...document.querySelectorAll('nav a, nav button, header a, header button')].map(textOf).filter(Boolean),
      forms: [...document.querySelectorAll('form')].map((f) => {
        const fields = [...f.querySelectorAll('input,select,textarea')]
          .filter((el) => !skipType.includes(String(el.type || '').toLowerCase()))
          .map((el) => ({
            name: el.getAttribute('name') || '',
            type: el.type || el.tagName.toLowerCase(),
            label: labelFor(el),
            required: Boolean(el.required),
          }));
        const sub = f.querySelector('button:not([type]), button[type="submit"], input[type="submit"]');
        return {
          id: f.id || '',
          name: f.getAttribute('name') || '',
          action: f.action || '',
          fields,
          submit: sub ? textOf(sub) : '',
        };
      }),
      buttons: [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
        .map(textOf).filter(Boolean),
      images: [...document.images].map((i) => ({ src: i.currentSrc || i.src, alt: i.getAttribute('alt') || '' })),
      ids: [...document.querySelectorAll('[id]')].map((e) => e.id),
    };
  });

  const origin = new URL(page.url()).origin;
  // Same-origin http(s) URLs become paths (origin dropped); cross-origin and other URLs stay as they are.
  const abs = (href) => {
    try {
      const u = new URL(href);
      return /^https?:$/.test(u.protocol) && u.origin === origin ? hrefKey(u.href) : u.href;
    } catch { return String(href || ''); }
  };

  const list = Array.isArray(errors) ? { console_errors: errors } : (errors || {});
  const errorList = (xs) => uniq((xs || []).map(cleanError).filter(Boolean), norm);

  return {
    title: raw.title,
    meta_description: raw.meta_description,
    headings: raw.headings,
    links: raw.links.filter((l) => !/^javascript:/i.test(l.href)).map((l) => ({ href: abs(l.href), text: l.text })),
    nav: raw.nav,
    forms: raw.forms.map((f) => ({ ...f, action: abs(f.action) })),
    buttons: raw.buttons,
    images: raw.images,
    ids: raw.ids,
    page_errors: errorList(list.page_errors),
    console_errors: errorList(list.console_errors),
  };
}

// Loads url in a fresh context. status is the HTTP status of the main document, or null.
export async function inventoryOfUrl(browser, url, vpName = 'desktop') {
  const { width, height, ...rest } = VIEWPORTS[vpName] || VIEWPORTS.desktop;
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    const status = response ? response.status() : null;
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* busy pages */ }
    const inventory = await extractInventory(page, errors);
    return { inventory, status };
  } finally {
    await ctx.close();
  }
}

// Waiver lines (KEEP.md "## Dropped" and "## Copy changes") are parsed once per distinct line.
const QUOTE = /"([^"]+)"|“([^”]+)”|`([^`]+)`/g;
const PATH_TOKEN = /(?:^|[\s"'`(“])(\/[\w\-./%~]+)/g;
const ABS_URL = /https?:\/\/[^\s"'`“”()<>]+/gi;
const pathPart = (v) => {
  const s = String(v ?? '').trim();
  let p = null;
  if (/^https?:\/\//i.test(s)) {
    try { p = new URL(s).pathname; } catch { return null; }
  } else if (s.startsWith('/')) {
    p = s.split(/[?#]/)[0];
  } else {
    return null;
  }
  return normPath(p.replace(/[.,;:!?]+$/, '')).toLowerCase();
};
const parseCache = new Map();
function parseWaiver(line) {
  const s = String(line ?? '');
  if (parseCache.has(s)) return parseCache.get(s);
  // On a "->" (or "→") line only the quotes left of the arrow are the old copy; the new copy does not waive.
  const cut = s.search(/->|→/);
  const left = cut < 0 ? s : s.slice(0, cut);
  const quotes = [...left.matchAll(QUOTE)].map((m) => words(m[1] ?? m[2] ?? m[3])).filter(Boolean);
  const paths = [
    ...[...s.matchAll(PATH_TOKEN)].map((m) => m[1]),
    ...[...s.matchAll(ABS_URL)].map((m) => m[0]),
  ].map(pathPart).filter((p) => p && p !== '/');
  const parsed = { quotes, paths };
  parseCache.set(s, parsed);
  return parsed;
}

// Does one of the waiver lines name this value?
//   kind 'href' or 'action': value is a path or URL; a /path token in a line waives it when equal to the
//     path or a path prefix of it ('/blog' waives '/blog/post-1'). '/' alone never counts.
//   any other kind (text, id, name, label, title, heading): value is compared with the quoted strings in
//     the line: equal letters-and-digits text, or a quote of 3+ words contained in the value on word
//     boundaries. Quotes may be "...", curly "..." or `...`. Single quotes never count.
export function isWaivedBy(lines, value, kind = 'text') {
  const list = lines == null ? [] : Array.isArray(lines) ? lines : [lines];
  if (kind === 'href' || kind === 'action') {
    const p = pathPart(value);
    if (!p || p === '/') return false;
    return list.some((l) => parseWaiver(l).paths.some((x) => p === x || p.startsWith(`${x}/`)));
  }
  const ws = words(value);
  if (!ws) return false;
  return list.some((l) => parseWaiver(l).quotes.some((q) => q === ws
    || (q.split(' ').length >= 3 && ` ${ws} `.includes(` ${q} `))));
}

// Ids generated by UI libraries (React useId, radix, headlessui, MUI, react-aria) change between renders.
const isGeneratedId = (id) => /[:«»]/.test(id) || /^(radix|headlessui|mui|react-aria)-/.test(id);

// Losses from base to now, as [{ severity, kind, message }]. Errors are unwaived losses that break the
// page; warnings are losses that may be intended or are unstable. waivedLines are the KEEP.md lines.
// base.unstable ({ ids, links, nav }) lists items seen in only one of two baseline loads; they are skipped.
// Missing page_errors or console_errors (older inventories) count as empty.
export function diffInventory(base, now, waivedLines = []) {
  const b = base || {};
  const n = now || {};
  // waivedLines: { dropped: [...], copy: [...] } from KEEP.md, or a plain array (treated as both).
  // Things that disappear (links, forms, fields, ids) are waived only by "## Dropped" lines: a copy
  // change rewords text, it does not remove anything. Reworded text (title, headings, nav labels)
  // is waived by either section.
  const asArr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const split = waivedLines && !Array.isArray(waivedLines) && typeof waivedLines === 'object';
  const dropped = split ? asArr(waivedLines.dropped) : asArr(waivedLines);
  const lines = split ? [...dropped, ...asArr(waivedLines.copy)] : dropped;
  const unstable = b.unstable || {};
  const unstableIds = new Set(unstable.ids || []);
  const unstableLinks = new Set((unstable.links || []).map((x) => hrefKey(typeof x === 'string' ? x : x?.href)));
  const unstableNav = new Set((unstable.nav || []).map((x) => norm(typeof x === 'string' ? x : x?.text)));
  const waivedText = (...c) => c.some((v) => isWaivedBy(lines, v, 'text'));
  const droppedText = (...c) => c.some((v) => isWaivedBy(dropped, v, 'text'));
  const waivedHref = (...c) => c.some((v) => isWaivedBy(dropped, v, 'href'));
  const out = [];
  const add = (severity, kind, message) => out.push({ severity, kind, message });

  if (b.title && b.title !== n.title && !waivedText(b.title)) {
    add('error', 'title', `title changed: "${b.title}" -> "${n.title || ''}"`);
  }

  const nowLinks = n.links || [];
  const nowHrefKeys = new Set(nowLinks.map((l) => hrefKey(l.href)));
  for (const l of uniq(b.links, (x) => hrefKey(x.href))) {
    const key = hrefKey(l.href);
    if (unstableLinks.has(key) || nowHrefKeys.has(key) || waivedHref(l.href) || droppedText(l.text)) continue;
    add('error', 'link', `lost link ${l.href}${l.text ? ` ("${l.text}")` : ''}`);
  }

  const nowNav = new Set((n.nav || []).map(norm));
  const nowButtons = new Set((n.buttons || []).map(norm));
  for (const t of uniq(b.nav, norm)) {
    const tn = norm(t);
    if (!tn || nowNav.has(tn) || unstableNav.has(tn) || waivedText(t)) continue;
    // Still in the page under another nav (a link with the same href or text, or a button): moved, not lost.
    const hrefs = new Set((b.links || []).filter((l) => norm(l.text) === tn).map((l) => hrefKey(l.href)));
    const elsewhere = nowLinks.some((l) => hrefs.has(hrefKey(l.href)) || norm(l.text) === tn) || nowButtons.has(tn);
    if (elsewhere) add('warning', 'nav', `nav item "${t}" moved out of the nav`);
    else add('error', 'nav', `lost nav item "${t}"`);
  }

  const nowForms = n.forms || [];
  const formKey = (f) => ((f.id || f.name) ? `n:${norm(f.id || f.name)}` : (f.action ? `a:${hrefKey(f.action)}` : ''));
  const fieldKey = (x) => norm(x.name || x.label);
  const fieldKeys = (f) => (f.fields || []).map(fieldKey).filter(Boolean);
  for (const bf of b.forms || []) {
    const bKeys = fieldKeys(bf);
    const label = bf.name || bf.id || bf.action || `${bKeys.length} fields`;
    let match = nowForms.find((nf) => formKey(nf) && formKey(nf) === formKey(bf));
    if (!match) {
      let best = 0;
      for (const nf of nowForms) {
        const shared = fieldKeys(nf).filter((k) => bKeys.includes(k)).length;
        if (shared > best) { best = shared; match = nf; }
      }
    }
    if (!match) {
      if (!droppedText(bf.id, bf.name) && !waivedHref(bf.action)) add('error', 'form', `lost form "${label}"`);
      continue;
    }
    const have = new Set(fieldKeys(match));
    for (const field of uniq(bf.fields || [], fieldKey)) {
      const k = fieldKey(field);
      if (!k || have.has(k) || droppedText(field.name, field.label)) continue;
      add('error', 'form-field', `lost form field "${field.name || field.label}" in form "${label}"`);
    }
  }

  const nowHeads = new Set((n.headings || []).map((h) => norm(h.text)));
  for (const h of uniq(b.headings, (x) => norm(x.text))) {
    if (norm(h.text) && !nowHeads.has(norm(h.text)) && !waivedText(h.text)) add('error', 'heading', `lost h${h.level} "${h.text}"`);
  }

  const nowIds = new Set(n.ids || []);
  for (const id of uniq(b.ids)) {
    if (!id || nowIds.has(id) || unstableIds.has(id) || droppedText(id)) continue;
    if (isGeneratedId(id)) add('warning', 'id', `lost id "${id}" (generated by a UI library, changes between renders)`);
    else add('error', 'id', `lost id "${id}"`);
  }

  const basePageErrors = new Set((b.page_errors || []).map(norm));
  for (const e of uniq(n.page_errors || [], norm)) {
    if (!basePageErrors.has(norm(e))) add('error', 'page-error', `new page error: "${e}"`);
  }
  const baseConsoleErrors = new Set((b.console_errors || []).map(norm));
  for (const e of uniq(n.console_errors || [], norm)) {
    if (!baseConsoleErrors.has(norm(e))) add('warning', 'console-error', `new console error: "${e}"`);
  }

  return out;
}
