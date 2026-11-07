// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "@playwright/test";
import { open, seed } from "./helpers.mjs";

test.describe("reading", () => {
  test("a Bill clause is rendered as structure you can follow", async ({ page, context }) => {
    await seed(context, { pos: { doc: "bill", idx: 8 } });
    await open(page);
    await expect(page.locator("#pageBody .sec").first()).toContainText("Clause 26");
    await expect(page.locator("#pageBody .sec").first()).toContainText("Obligations for High-Risk"); // not ALL CAPS
    await expect(page.getByRole("heading", { level: 2, name: /Artificial Intelligence Bill.*page 9/ })).toBeAttached();
    const markers = await page.locator("#pageBody .item .marker").allTextContents();
    expect(markers.slice(0, 3)).toEqual(["(1)", "(a)", "(b)"]);
    await expect(page.locator("#crumbs")).toContainText("Clause 26");
    await expect(page.locator("#timeLeft")).toContainText("min left in Bill");
    await expect(page.locator("#upNext")).toContainText("Up next");
    expect(Number(await page.locator("#docProgress").getAttribute("aria-valuenow"))).toBeGreaterThan(50);
  });

  test("defined terms open the Bill's definition", async ({ page, context }) => {
    await seed(context, { pos: { doc: "bill", idx: 8 } });
    await open(page);
    await page.locator("#pageBody .term").first().click();
    await expect(page.locator(".term-pop")).toContainText("means");
    await expect(page.locator(".term-pop .ref")).toHaveText(/^Bill, p\.2 ¶\d+$/);
    // The definition link lands on the paragraph that defines the term.
    const para = (await page.locator(".term-pop .ref").textContent()).match(/¶(\d+)/)[1];
    const term = (await page.locator(".term-pop strong").textContent()).toLowerCase();
    await page.locator(".term-pop .ref").click();
    const landed = page.locator(`#pageBody [data-para="${para}"]`);
    await expect(landed).toHaveClass(/landed/);
    expect((await landed.textContent()).toLowerCase()).toContain(term);
  });

  test("paragraphs are numbered for citations, and the numbers can be hidden", async ({ page, context }) => {
    await seed(context, { pos: { doc: "bill", idx: 10 } });
    await open(page);
    const nums = await page.locator("#pageBody [data-para]").evaluateAll((els) => els.map((e) => e.dataset.para));
    expect(nums.length).toBeGreaterThan(2);
    expect(nums).toEqual(nums.map((_, i) => String(i + 1)));
    const shown = () => page.locator("#pageBody [data-para]").first().evaluate((e) => getComputedStyle(e, "::before").content);
    expect(await shown()).toBe('"1"');
    expect(await page.locator("#pageBody").textContent()).not.toMatch(/^1/); // the number isn't part of the text
    await page.locator("#settingsBtn").click();
    await page.locator("#paraNumsToggle").uncheck();
    expect(await shown()).toBe("none");
  });

  test("the three palettes and text settings apply", async ({ page, context }) => {
    await open(page);
    const chrome = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chrome").trim());
    const seen = new Set();
    for (const palette of ["golden", "coastal", "terracotta"]) {
      await page.locator("#settingsBtn").click();
      await page.locator(`.palette-opt[data-v="${palette}"]`).click();
      await expect(page.locator("html")).toHaveAttribute("data-palette", palette);
      seen.add(await chrome());
      await page.keyboard.press("Escape");
    }
    expect(seen.size).toBe(3);
    await page.locator("#settingsBtn").click();
    await page.locator('[data-pref="font"] [data-v="hyperlegible"]').click();
    await page.locator('[data-pref="spacing"] [data-v="wide"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-font", "hyperlegible");
    const family = await page.locator("#pageBody p, #pageBody .item").first().evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain("Atkinson Hyperlegible");
  });

  test("works offline after the first visit", async ({ page, context }) => {
    await open(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(1000); // let the service worker finish precaching
    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await expect(page.locator("#pageBody .sentence").first()).toBeVisible();
    await expect(page.locator("#netText")).toContainText("Offline");
    await page.keyboard.press("/");
    await page.locator("#searchInput").fill("regulatory sandbox");
    await expect(page.locator("#searchMeta")).toContainText("offline");
    await context.setOffline(false);
  });
});
