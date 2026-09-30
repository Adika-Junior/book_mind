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

/** Select the n-th occurrence (0-based) of `phrase` in the page body, as a reader would. */
export async function selectPhrase(page, phrase, occurrence = 0) {
  await page.evaluate(([phrase, occurrence]) => {
    const body = document.getElementById("pageBody");
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, text.length]); text += n.nodeValue; }
    let at = -1;
    for (let k = 0; k <= occurrence; k++) at = text.indexOf(phrase, at + 1);
    if (at < 0) throw new Error(`phrase not found: ${phrase}`);
    const pos = (i) => { const [n, s] = nodes.findLast(([, s]) => s <= i); return [n, i - s]; };
    const r = document.createRange();
    r.setStart(...pos(at));
    r.setEnd(...pos(at + phrase.length));
    r.startContainer.parentElement.scrollIntoView({ block: "center" }); // readers select what they can see
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, [phrase, occurrence]);
  await page.waitForTimeout(150); // let the scroll settle before the toolbar is positioned
  await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
  await page.locator("#selToolbar.show").waitFor();
}
