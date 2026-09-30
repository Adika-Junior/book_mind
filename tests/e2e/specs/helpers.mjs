// SPDX-License-Identifier: AGPL-3.0-or-later
/** Seed per-device preferences (localStorage) before the app boots — only if not already set. */
export async function seed(context, prefs) {
  await context.addInitScript((p) => {
    for (const [k, v] of Object.entries(p)) if (localStorage.getItem("bm_" + k) === null) localStorage.setItem("bm_" + k, JSON.stringify(v));
  }, prefs);
}

export async function open(page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#pageBody .sentence").first().waitFor();
}

/** Select sentence i on the page (-1 = the longest), like a reader dragging over it. */
export async function selectSentence(page, i) {
  await page.evaluate((i) => {
    const all = [...document.querySelectorAll("#pageBody .sentence")].filter((s) => !s.closest("h2, h3, h4"));
    const s = i < 0 ? all.sort((a, b) => b.textContent.length - a.textContent.length)[0] : all[i];
    const r = document.createRange();
    r.selectNodeContents(s);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, i);
  await page.locator("#selToolbar.show").waitFor();
}

export const unique = (prefix) => `${prefix} ${Math.random().toString(36).slice(2, 7)}`;
