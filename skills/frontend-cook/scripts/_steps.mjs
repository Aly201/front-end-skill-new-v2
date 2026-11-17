// Interaction steps shared by shoot.mjs (state screenshots), regress.mjs and baseline.mjs (probes).
// Selectors are by role and accessible name, or by label, so they survive a redesign:
//   { "click": { "role": "button", "name": "Menu" } }
//   { "click": { "text": "Pricing" } }
//   { "fill":  { "label": "Email", "value": "a@b.co" } }
//   { "hover": { "role": "link", "name": "Docs" } }
//   { "press": "Enter" }   { "wait": 300 }
// Matching is a substring, case-insensitive, unless the selector says "exact": true.
// Expectations (probes only):
//   { "visible": { "role": "dialog" } }  { "text": "Thanks" }  { "request": "/api/contact" }
// Probes may also carry "mock": [{ "url": "/api/contact", "status": 200, "body": {...} }] (see applyMocks).

export function locate(page, sel) {
  if (!sel || typeof sel !== 'object') throw new Error(`bad selector ${JSON.stringify(sel)}`);
  const exact = sel.exact === true;
  if (sel.label) return page.getByLabel(sel.label, { exact }).first();
  if (sel.role) return page.getByRole(sel.role, sel.name ? { name: sel.name, exact } : {}).first();
  if (sel.text) return page.getByText(sel.text, { exact }).first();
  if (sel.placeholder) return page.getByPlaceholder(sel.placeholder, { exact }).first();
  throw new Error(`selector needs label, role, text or placeholder: ${JSON.stringify(sel)}`);
}

export async function runSteps(page, steps = [], timeout = 5000) {
  for (const s of steps) {
    if (s.click) await locate(page, s.click).click({ timeout });
    else if (s.fill) await locate(page, s.fill).fill(String(s.fill.value ?? ''), { timeout });
    else if (s.hover) await locate(page, s.hover).hover({ timeout });
    else if (s.press) await page.keyboard.press(s.press);
    else if (s.wait) await page.waitForTimeout(Math.min(Number(s.wait) || 0, 10000));
    else throw new Error(`unknown step ${JSON.stringify(s)}`);
  }
}

// Requests are recorded as { url, nav } by recordRequests (nav: a full-page navigation, e.g. a native form submit).
// A plain string (a bare URL) is accepted too.
export const requestUrl = (r) => (typeof r === 'string' ? r : String(r?.url ?? ''));

// Starts recording the page's requests into the returned array. Callers clear it (requests.length = 0)
// right before the steps, so the page's own document load never counts as a request expectation.
export function recordRequests(page) {
  const list = [];
  page.on('request', (r) => list.push({ url: r.url(), nav: r.isNavigationRequest() }));
  return list;
}

// One expectation: null when it holds, otherwise a failure string.
async function checkOne(page, e, requests, timeout) {
  try {
    if (e.visible) await locate(page, e.visible).waitFor({ state: 'visible', timeout });
    else if (e.text) await page.getByText(e.text, { exact: false }).first().waitFor({ state: 'visible', timeout });
    else if (e.request) {
      const t0 = Date.now();
      const seen = () => requests.some((r) => requestUrl(r).includes(e.request));
      while (!seen() && Date.now() - t0 < timeout) await page.waitForTimeout(100);
      if (!seen()) throw new Error(`no request to ${e.request}`);
    } else throw new Error(`unknown expectation ${JSON.stringify(e)}`);
    return null;
  } catch (err) {
    return `${JSON.stringify(e)}: ${String(err.message).split('\n')[0]}`;
  }
}

// Returns a list of failure strings; empty means every expectation held.
export async function checkExpect(page, expect = [], requests = [], timeout = 4000) {
  const fails = [];
  for (const e of expect) {
    const f = await checkOne(page, e, requests, timeout);
    if (f) fails.push(f);
  }
  return fails;
}

// One boolean per expectation, in order: true when it holds now (same waiting as checkExpect).
export async function checkExpectEach(page, expect = [], requests = [], timeout = 4000) {
  const out = [];
  for (const e of expect) out.push(await checkOne(page, e, requests, timeout) === null);
  return out;
}

// One entry per expectation: for a request expectation, true when a matching request was a full-page
// navigation, false when every matching request was a fetch or XHR, null when none matched or it is not a
// request expectation. Call after checkExpect/checkExpectEach (the requests have already been waited for).
export function requestNavEach(expect = [], requests = []) {
  return expect.map((e) => {
    if (!e || !e.request) return null;
    const hits = requests.filter((r) => requestUrl(r).includes(e.request));
    if (!hits.length) return null;
    return hits.some((r) => r.nav === true);
  });
}

// True when the main frame ended on a mocked URL it did not start on (a native form submit to a mocked endpoint
// navigates to it; a JS handler that fetches does not).
export function endsOnMock(finalUrl, startUrl, mocks = []) {
  if (!finalUrl || finalUrl === startUrl) return false;
  return (Array.isArray(mocks) ? mocks : []).some((m) => m && typeof m.url === 'string' && m.url
    && String(finalUrl).includes(m.url));
}

// One boolean per expectation, read immediately with no waiting (for the state before the steps).
// A request expectation is always false: nothing can have been requested before the steps ran.
export async function expectNow(page, expect = []) {
  const out = [];
  for (const e of expect) {
    try {
      if (e.visible) out.push(await locate(page, e.visible).isVisible());
      else if (e.text) out.push(await page.getByText(e.text, { exact: false }).first().isVisible());
      else out.push(false);
    } catch {
      out.push(false);
    }
  }
  return out;
}

// Fulfils every request whose URL includes mock.url with a fixed response, so a probe never reaches a real endpoint.
// Defaults: status 200, body '{}', contentType application/json. The request still shows up in page 'request' events.
export async function applyMocks(page, mocks = []) {
  for (const m of Array.isArray(mocks) ? mocks : []) {
    if (!m || typeof m.url !== 'string' || !m.url) throw new Error(`mock needs a url: ${JSON.stringify(m)}`);
    const body = m.body === undefined ? '{}' : typeof m.body === 'string' ? m.body : JSON.stringify(m.body);
    await page.route((u) => String(u).includes(m.url), (route) => route.fulfill({
      status: m.status ?? 200,
      contentType: m.contentType || 'application/json',
      body,
    }));
  }
}
