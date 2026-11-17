// Unit tests for skills/frontend-cook/scripts/_inventory.mjs (no browser).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffInventory, isWaivedBy, extractInventory, inventoryOfUrl, watchErrors } from '../skills/frontend-cook/scripts/_inventory.mjs';

const L = (href, text) => ({ href: `http://x${href}`, text });
const errs = (r) => r.filter((f) => f.severity === 'error');
const warns = (r) => r.filter((f) => f.severity === 'warning');

// The B2 defender cases: false waivers must be errors, honest waivers must still waive.
const B2_LINES = [
  '- Page title on /: "Home | Acme Solutions" -> "Acme: project tracking for agencies". User: "the titles should say what we do"',
  '- Newsletter label "Your email" -> "Work email". User: "ask for their work email in the newsletter box"',
  '- Pricing CTA "Contact sales" -> "Talk to sales".',
  '- Menu button label "Menu" -> "Open menu".',
  '- Hero h1 "Unlock the power of rope" -> "Rope for climbers". User: "say what we do"',
  '- Section heading "Our Features" -> "What you get".',
  '- The /blog page. User: "drop the blog, nobody reads it"',
  '- Promo id `promo-banner` removed. User: "lose the banner"',
];
const B2_BASE = {
  title: 'Home | Acme Solutions',
  links: [L('/', 'Home'), L('/contact', 'Contact'), L('/blog', 'Blog'), L('/blog/post-1', 'First post'), L('/pricing', 'Pricing')],
  nav: ['Home', 'Contact', 'Menu', 'Pricing'],
  headings: [{ level: 1, text: 'Unlock the power of rope — seamlessly' }, { level: 2, text: '🚀 Our Features!' }, { level: 2, text: 'Solutions' }, { level: 2, text: 'Email' }],
  forms: [{ id: 'nl', name: '', action: 'http://x/api/subscribe', fields: [{ name: 'email', label: 'Your email' }, { name: 'company', label: 'Company' }] }],
  ids: ['promo-banner', 'pricing'],
};
const B2_NOW = { title: 'Acme: project tracking', links: [L('/pricing', 'Pricing')], nav: ['Pricing'], headings: [], forms: [{ id: 'nl', fields: [] }], ids: [] };
const msgs = (base, now, lines) => diffInventory(base, now, lines).map((f) => f.message);

describe('B2 waiver rule through diffInventory', () => {
  test('false waivers are errors', () => {
    const m = msgs(B2_BASE, B2_NOW, B2_LINES);
    for (const expected of ['"Home"', '/contact', 'nav item "Contact"', 'nav item "Home"', '"Solutions"', 'h2 "Email"', 'field "company"', '"pricing"']) {
      assert.ok(m.some((x) => x.includes(expected)), `expected an error mentioning ${expected}; got ${m.join(' | ')}`);
    }
    const sev = Object.fromEntries(diffInventory(B2_BASE, B2_NOW, B2_LINES).map((f) => [f.message, f.severity]));
    assert.equal(sev[m.find((x) => x.includes('nav item "Home"'))], 'error');
  });

  test('honest waivers still waive', () => {
    const m = msgs(B2_BASE, B2_NOW, B2_LINES).join('\n');
    for (const waived of ['title', 'Unlock', 'Our Features', '/blog ', 'nav item "Menu"', 'promo-banner', 'field "email"']) {
      assert.ok(!m.includes(waived), `${waived} should be waived; got ${m}`);
    }
  });

  test('a field waived only by a substring of a longer quote is an error', () => {
    const base = { forms: [{ id: 'nl', fields: [{ name: 'email', label: 'Your email' }] }] };
    const now = { forms: [{ id: 'nl', fields: [] }] };
    const line = '- The newsletter box is gone. User: "ask for their work email in the newsletter box"';
    assert.equal(errs(diffInventory(base, now, [line])).length, 1);
    assert.equal(errs(diffInventory(base, now, ['- Email field removed: "Your email" is no longer asked'])).length, 0, 'a quote equal to the label is the old copy and waives');
    assert.equal(errs(diffInventory(base, now, ['- Email field removed: "Your" is no longer asked'])).length, 1, 'a one-word part of the label does not waive');
  });
});

describe('isWaivedBy', () => {
  test('text: exact letters-and-digits equality on the old copy only', () => {
    assert.equal(isWaivedBy(['- Title "Home | Acme Solutions" -> "New"'], 'Home | Acme Solutions', 'text'), true);
    assert.equal(isWaivedBy(['- Title "Home | Acme Solutions" -> "New"'], 'Home', 'text'), false);
    assert.equal(isWaivedBy(['- Label "Old" -> "Menu"'], 'Menu', 'text'), false, 'quote right of the arrow does not waive');
    assert.equal(isWaivedBy(['- Button "Menu" -> "Open menu"'], 'Menu', 'text'), true);
  });

  test('text: a 3+ word quote waives an item that contains it on word boundaries only', () => {
    const line = ['- Hero "Unlock the power of rope" -> "Rope"'];
    assert.equal(isWaivedBy(line, 'Unlock the power of rope — seamlessly', 'text'), true);
    assert.equal(isWaivedBy(line, 'Unlock the power of ropes', 'text'), false);
    assert.equal(isWaivedBy(['- "Unlock the" changed'], 'Unlock the power', 'text'), false, 'two words are too loose');
  });

  test('text: backticks and curly quotes count, single quotes do not', () => {
    assert.equal(isWaivedBy(['- id `promo-banner` removed'], 'promo banner', 'text'), true);
    assert.equal(isWaivedBy(['- id “promo banner” removed'], 'promo-banner', 'text'), true);
    assert.equal(isWaivedBy(["- label 'Your email' changed"], 'Your email', 'text'), false);
  });

  test('href: a /path token waives that path and paths below it, not siblings', () => {
    const line = ['- The /blog page. User: "drop the blog, nobody reads it"'];
    assert.equal(isWaivedBy(line, '/blog', 'href'), true);
    assert.equal(isWaivedBy(line, '/blog/post-1', 'href'), true);
    assert.equal(isWaivedBy(line, 'http://x/blog/post-1?x=1', 'href'), true);
    assert.equal(isWaivedBy(line, '/blogs', 'href'), false);
    assert.equal(isWaivedBy(line, '/contact', 'href'), false);
  });

  test('href: a bare slash never counts, and action uses the same path rule', () => {
    assert.equal(isWaivedBy(['- The home page / is gone'], '/', 'href'), false);
    assert.equal(isWaivedBy(['- Form at /api/contact removed'], '/api/contact?x=1', 'action'), true);
  });

  test('no lines, empty values and missing kind are safe', () => {
    assert.equal(isWaivedBy([], 'Home', 'text'), false);
    assert.equal(isWaivedBy(undefined, '/x', 'href'), false);
    assert.equal(isWaivedBy(['- "Home" removed'], '', 'text'), false);
  });
});

describe('diffInventory severities and rules', () => {
  test('unstable ids, links and nav are skipped', () => {
    const base = {
      ids: ['gone'], links: [L('/x', 'X')], nav: ['Y'],
      unstable: { ids: ['gone'], links: ['http://x/x'], nav: ['Y'] },
    };
    assert.deepEqual(diffInventory(base, { ids: [], links: [], nav: [] }, []), []);
  });

  test('an id generated by a UI library is a warning, a plain id is an error', () => {
    const base = { ids: [':r1:', 'radix-:r2:', 'mui-42', 'contact'] };
    const r = diffInventory(base, { ids: [] }, []);
    const byId = Object.fromEntries(r.map((f) => [f.message.match(/"([^"]+)"/)[1], f.severity]));
    assert.equal(byId[':r1:'], 'warning');
    assert.equal(byId['radix-:r2:'], 'warning');
    assert.equal(byId['mui-42'], 'warning');
    assert.equal(byId.contact, 'error');
  });

  test('a nav item still present as a link elsewhere is a warning', () => {
    const base = { nav: ['Blog'], links: [L('/blog', 'Blog')] };
    const now = { nav: [], links: [L('/blog', 'Journal')] };
    const r = diffInventory(base, now, []);
    assert.equal(r.length, 1);
    assert.equal(r[0].severity, 'warning');
    assert.equal(r[0].kind, 'nav');
    assert.match(r[0].message, /moved out of the nav/);
  });

  test('a nav item whose text is now a button is a warning; a truly lost one is an error', () => {
    const base = { nav: ['Book demo', 'Gone'] };
    const now = { nav: [], buttons: ['Book demo'] };
    const r = diffInventory(base, now, []);
    assert.deepEqual(r.map((f) => [f.severity, f.kind]), [['warning', 'nav'], ['error', 'nav']]);
  });

  test('a new page error is an error, a new console error is a warning, known ones are silent', () => {
    const base = { page_errors: ['Boom at init'], console_errors: ['Failed to load resource: 404'] };
    const now = {
      page_errors: ['Boom at init', 'TypeError: x is undefined'],
      console_errors: ['Failed to load resource: 404', 'Warn: slow'],
    };
    const r = diffInventory(base, now, []);
    assert.equal(r.length, 2);
    assert.deepEqual([r[0].severity, r[0].kind], ['error', 'page-error']);
    assert.match(r[0].message, /TypeError: x is undefined/);
    assert.deepEqual([r[1].severity, r[1].kind], ['warning', 'console-error']);
    assert.match(r[1].message, /Warn: slow/);
  });

  test('a baseline with absolute same-origin hrefs and action vs now with paths gives no link or form errors', () => {
    const base = {
      links: [{ href: 'http://localhost:5173/pricing', text: 'Pricing' }, { href: 'http://localhost:5173/', text: 'Home' }],
      forms: [{ id: '', name: '', action: 'http://localhost:5173/api/contact?x=1', fields: [{ name: 'email', label: 'Email' }] }],
    };
    const now = {
      links: [{ href: '/pricing', text: 'Pricing' }, { href: '/', text: 'Home' }],
      forms: [{ id: '', name: '', action: '/api/contact?x=1', fields: [{ name: 'email', label: 'Email' }] }],
    };
    assert.deepEqual(diffInventory(base, now, []), []);
  });

  test('an absolute cross-origin href still counts as a link', () => {
    const base = { links: [{ href: 'https://other.example/docs', text: 'Docs' }] };
    assert.equal(errs(diffInventory(base, { links: [] }, [])).length, 1);
  });

  test('older inventories without page_errors, console_errors, unstable or links do not crash', () => {
    const old = { title: 'T', headings: [{ level: 1, text: 'H' }], links: [], nav: [], forms: [], ids: [] };
    assert.deepEqual(diffInventory(old, old), []);
    assert.deepEqual(diffInventory(old, { title: 'T', headings: [] }, []).map((f) => f.kind), ['heading']);
    assert.deepEqual(diffInventory(null, null), []);
    assert.deepEqual(diffInventory(old, { ...old, console_errors: ['x'] }).map((f) => f.severity), ['warning']);
  });
});

// A fake Playwright page: evaluate() returns the raw DOM data for the second (read) call.
function fakePage(url, raw, { errorsFired = [] } = {}) {
  const listeners = {};
  return {
    on: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    emit: (ev, arg) => (listeners[ev] || []).forEach((fn) => fn(arg)),
    url: () => url,
    evaluate: async (fn) => (String(fn).includes('scrollTo') && !String(fn).includes('textOf') ? undefined : raw),
    fired: errorsFired,
  };
}
const RAW = {
  title: 'Acme',
  meta_description: '',
  headings: [{ level: 1, text: 'Hi' }],
  links: [
    { href: 'http://site.test/pricing/', text: 'Pricing' },
    { href: 'http://site.test/index.html', text: 'Home' },
    { href: 'http://site.test/api?x=1#top', text: 'Api' },
    { href: 'https://other.example/docs', text: 'Docs' },
    { href: 'javascript:void(0)', text: 'Menu' },
    { href: 'mailto:hi@site.test', text: 'Mail' },
  ],
  nav: ['Pricing'],
  forms: [{ id: 'f', name: '', action: 'http://site.test/api/contact?x=1', fields: [], submit: 'Send' }],
  buttons: ['Send'],
  images: [],
  ids: ['f'],
};

describe('extractInventory', () => {
  test('same-origin hrefs and actions become paths, others stay absolute, javascript links are dropped', async () => {
    const inv = await extractInventory(fakePage('http://site.test/', RAW), { page_errors: [], console_errors: [] });
    assert.deepEqual(inv.links.map((l) => l.href), ['/pricing', '/', '/api?x=1', 'https://other.example/docs', 'mailto:hi@site.test']);
    assert.equal(inv.forms[0].action, '/api/contact?x=1');
    assert.equal(inv.title, 'Acme');
  });

  test('page errors and console errors are kept apart, with URLs and line:col stripped', async () => {
    const errors = {
      page_errors: ['Uncaught TypeError at http://site.test/app.js:12:5', 'Uncaught TypeError at http://site.test/app.js:99:1'],
      console_errors: ['Failed to load resource: the server responded with a status of 404 (http://site.test/missing.png)', 'Failed to load resource: the server responded with a status of 404 ()'],
    };
    const inv = await extractInventory(fakePage('http://site.test/', RAW), errors);
    assert.deepEqual(inv.page_errors, ['Uncaught TypeError at']);
    assert.deepEqual(inv.console_errors, ['Failed to load resource: the server responded with a status of 404']);
  });

  test('a plain array of errors is read as console errors', async () => {
    const inv = await extractInventory(fakePage('http://site.test/', RAW), ['boom']);
    assert.deepEqual(inv.console_errors, ['boom']);
    assert.deepEqual(inv.page_errors, []);
  });

  test('watchErrors collects page and console errors separately', () => {
    const page = fakePage('http://site.test/', RAW);
    const errors = watchErrors(page);
    page.emit('pageerror', new Error('bad'));
    page.emit('console', { type: () => 'error', text: () => 'nope' });
    page.emit('console', { type: () => 'log', text: () => 'ignored' });
    assert.deepEqual(errors, { page_errors: ['bad'], console_errors: ['nope'] });
  });
});

describe('inventoryOfUrl', () => {
  test('returns { inventory, status } from a fake browser', async () => {
    const page = fakePage('http://site.test/missing', RAW);
    page.goto = async () => ({ status: () => 404 });
    page.waitForLoadState = async () => {};
    page.on = ((on) => (ev, fn) => on(ev, fn))(page.on);
    const browser = {
      newContext: async (opts) => {
        assert.equal(opts.viewport.width, 1440);
        return { newPage: async () => page, close: async () => {} };
      },
    };
    const r = await inventoryOfUrl(browser, 'http://site.test/missing', 'desktop');
    assert.equal(r.status, 404);
    assert.equal(r.inventory.title, 'Acme');
    assert.deepEqual(r.inventory.page_errors, []);
  });

  test('status is null when the navigation gives no response', async () => {
    const page = fakePage('about:blank', RAW);
    page.goto = async () => null;
    page.waitForLoadState = async () => {};
    const browser = { newContext: async () => ({ newPage: async () => page, close: async () => {} }) };
    const r = await inventoryOfUrl(browser, 'about:blank');
    assert.equal(r.status, null);
  });
});

test('a copy change rewords text but never waives a removal; a Dropped line does', () => {
  const base = { forms: [{ id: 'news', fields: [{ name: 'email', label: 'Your email' }] }], headings: [{ level: 1, text: 'Unlock the power of rope today' }], links: [{ href: '/about', text: 'About' }] };
  const now = { forms: [{ id: 'news', fields: [] }], headings: [], links: [] };
  const copy = ['Newsletter label "Your email" -> "Work email"', 'h1 "Unlock the power of rope" -> "Rope for boats"', 'Nav "About" -> "Our story"'];
  const msgs = diffInventory(base, now, { dropped: [], copy }).map((x) => x.message);
  assert.ok(msgs.some((m) => m.includes('lost form field "email"')), 'relabel does not waive removing the field');
  assert.ok(msgs.some((m) => m.includes('lost link /about')), 'a copy change does not waive removing a link');
  assert.ok(!msgs.some((m) => m.includes('lost h1')), 'a reworded heading is waived by a copy change');
  const dropped = ['newsletter field "email" removed', 'page `/about` merged into home'];
  assert.deepEqual(diffInventory(base, now, { dropped, copy }).map((x) => x.message), []);
});
