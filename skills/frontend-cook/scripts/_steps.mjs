// Interaction steps shared by shoot.mjs (state screenshots), regress.mjs and baseline.mjs (probes).
// Selectors are by role and accessible name, or by label, so they survive a redesign:
//   { "click": { "role": "button", "name": "Menu" } }
//   { "click": { "text": "Pricing" } }
//   { "fill":  { "label": "Email", "value": "a@b.co" } }
//   { "hover": { "role": "link", "name": "Docs" } }
//   { "press": "Enter" }   { "wait": 300 }
// Expectations (probes only):
//   { "visible": { "role": "dialog" } }  { "text": "Thanks" }  { "request": "/api/contact" }

export function locate(page, sel) {
  if (!sel || typeof sel !== 'object') throw new Error(`bad selector ${JSON.stringify(sel)}`);
  if (sel.label) return page.getByLabel(sel.label, { exact: false }).first();
  if (sel.role) return page.getByRole(sel.role, sel.name ? { name: sel.name, exact: false } : {}).first();
  if (sel.text) return page.getByText(sel.text, { exact: false }).first();
  if (sel.placeholder) return page.getByPlaceholder(sel.placeholder).first();
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

// Returns a list of failure strings; empty means every expectation held.
export async function checkExpect(page, expect = [], requests = [], timeout = 4000) {
  const fails = [];
  for (const e of expect) {
    try {
      if (e.visible) await locate(page, e.visible).waitFor({ state: 'visible', timeout });
      else if (e.text) await page.getByText(e.text, { exact: false }).first().waitFor({ state: 'visible', timeout });
      else if (e.request) {
        const t0 = Date.now();
        while (!requests.some((u) => u.includes(e.request)) && Date.now() - t0 < timeout) await page.waitForTimeout(100);
        if (!requests.some((u) => u.includes(e.request))) throw new Error(`no request to ${e.request}`);
      } else throw new Error(`unknown expectation ${JSON.stringify(e)}`);
    } catch (err) { fails.push(`${JSON.stringify(e)}: ${String(err.message).split('\n')[0]}`); }
  }
  return fails;
}
