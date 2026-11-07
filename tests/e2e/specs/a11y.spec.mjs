// SPDX-License-Identifier: AGPL-3.0-or-later
// Automated WCAG 2.2 AA audit with axe-core. (Automated checks catch roughly a third to a half of
// issues; keyboard and screen-reader passes are still worth doing by hand.)
import { createRequire } from "node:module";
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { open, seed } from "./helpers.mjs";

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
test.use({ bypassCSP: true }); // the app's CSP (rightly) blocks injected scripts, including axe

async function audit(page) {
  await page.addScriptTag({ content: axeSource });
  const { violations } = await page.evaluate(() => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
  }));
  return violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`);
}

for (const palette of ["golden", "coastal", "terracotta"]) {
  for (const theme of ["light", "dark"]) {
    test(`no WCAG violations: ${palette} ${theme}`, async ({ page, context }) => {
      await seed(context, { palette, theme, pos: { doc: "bill", idx: 8 } });
      await open(page);
      expect(await audit(page)).toEqual([]);
    });
  }
}

test("no WCAG violations: notebook, settings and search", async ({ page, context }) => {
  await seed(context, { pos: { doc: "digest", idx: 8 } });
  await open(page);
  await page.locator("#notebookBtn").click();
  expect(await audit(page)).toEqual([]);
  await page.locator("#notebookClose").click();
  await page.locator("#settingsBtn").click();
  expect(await audit(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await page.locator("#searchInput").fill("sandbox");
  await expect(page.locator("#searchResults .result").first()).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

test("keyboard: open and close the notebook and search without a mouse", async ({ page }) => {
  await open(page);
  await page.keyboard.press("n");
  await expect(page.locator("#notebook")).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await expect(page.locator("#searchInput")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#searchDialog")).toBeHidden();
});
