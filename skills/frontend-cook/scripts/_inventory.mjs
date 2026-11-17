// Shared page inventory for baseline.mjs and regress.mjs: what a rendered page has (links, nav,
// forms and fields, headings, buttons, images, ids, title) and how a later build differs from it.
//   extractInventory(page, consoleErrors?)  reads the DOM of a loaded Playwright page
//   diffInventory(base, now, waivedTexts)   returns the unwaived losses as [{ severity, kind, message }]
//   inventoryOfUrl(browser, url, vp?)       opens a fresh context, loads the URL, returns the inventory
//   watchErrors(page)                       collects console and page errors (attach before goto)
import { normUrl } from './_common.mjs';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = (s) => clean(s).toLowerCase();

export function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(clean(m.text()).slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(clean(e.message).slice(0, 300)));
  return errors;
}

// Reads the inventory of a loaded page. The page is scrolled once (top to bottom, then back up)
// so lazy content and scroll reveals are in the DOM before it is read.
export async function extractInventory(page, consoleErrors = []) {
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
  // Same-origin URLs are normalized (trailing slash, index.html, hash); others are kept as they are.
  const abs = (href) => {
    try { const u = new URL(href); return u.origin === origin ? normUrl(u.href) : u.href; }
    catch { return String(href || ''); }
  };
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
    console_errors: consoleErrors.slice(),
  };
}

export async function inventoryOfUrl(browser, url, vpName = 'desktop') {
  const { width, height, ...rest } = VIEWPORTS[vpName] || VIEWPORTS.desktop;
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* busy pages */ }
    return await extractInventory(page, errors);
  } finally {
    await ctx.close();
  }
}

// Losses from base to now. Every finding is an error unless the item's text, href, name, id or
// label appears (lowercased, as a substring) in one of waivedTexts (the lines of KEEP.md
// "## Dropped" and "## Copy changes").
export function diffInventory(base, now, waivedTexts = []) {
  const b = base || {};
  const n = now || {};
  const waived = (waivedTexts || []).map((l) => String(l).toLowerCase());
  const isWaived = (...cands) => cands.some((c) => {
    const s = norm(c);
    return s && waived.some((l) => l.includes(s));
  });
  const out = [];
  const add = (kind, message) => out.push({ severity: 'error', kind, message });
  const uniq = (arr, key = (x) => x) => {
    const seen = new Set();
    return (arr || []).filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  if (b.title && b.title !== n.title && !isWaived(b.title)) {
    add('title', `title changed: "${b.title}" -> "${n.title || ''}"`);
  }

  const nowHrefs = new Set((n.links || []).map((l) => l.href));
  for (const l of uniq(b.links, (x) => x.href)) {
    if (!nowHrefs.has(l.href) && !isWaived(l.href, l.text)) {
      add('link', `lost link ${l.href}${l.text ? ` ("${l.text}")` : ''}`);
    }
  }

  const nowNav = new Set((n.nav || []).map(norm));
  for (const t of uniq(b.nav, norm)) {
    if (!nowNav.has(norm(t)) && !isWaived(t)) add('nav', `lost nav item "${t}"`);
  }

  const formKey = (f) => norm(f.id || f.name || f.action || '');
  const fieldKey = (x) => norm(x.name || x.label);
  const fieldKeys = (f) => (f.fields || []).map(fieldKey).filter(Boolean);
  for (const bf of b.forms || []) {
    const bKeys = fieldKeys(bf);
    const label = bf.name || bf.id || bf.action || `${bKeys.length} fields`;
    let match = (n.forms || []).find((nf) => formKey(nf) && formKey(nf) === formKey(bf));
    if (!match) {
      let best = 0;
      for (const nf of n.forms || []) {
        const shared = fieldKeys(nf).filter((k) => bKeys.includes(k)).length;
        if (shared > best) { best = shared; match = nf; }
      }
    }
    if (!match) {
      if (!isWaived(bf.id, bf.name, bf.action)) add('form', `lost form "${label}"`);
      continue;
    }
    const have = new Set(fieldKeys(match));
    for (const field of uniq(bf.fields || [], fieldKey)) {
      const k = fieldKey(field);
      if (!k || have.has(k)) continue;
      if (!isWaived(field.name, field.label)) {
        add('form-field', `lost form field "${field.name || field.label}" in form "${label}"`);
      }
    }
  }

  const nowHeads = new Set((n.headings || []).map((h) => norm(h.text)));
  for (const h of uniq(b.headings, (x) => norm(x.text))) {
    if (!nowHeads.has(norm(h.text)) && !isWaived(h.text)) add('heading', `lost h${h.level} "${h.text}"`);
  }

  const nowIds = new Set(n.ids || []);
  for (const id of uniq(b.ids)) {
    if (id && !nowIds.has(id) && !isWaived(id)) add('id', `lost id "${id}"`);
  }

  return out;
}
