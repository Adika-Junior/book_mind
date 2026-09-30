// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { open, seed, selectSentence } from "./helpers.mjs";

test.describe("research with the local model and the web", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));

  test("Research uses the local model and cites the documents", async ({ page, context }) => {
    await seed(context, { pos: { doc: "bill", idx: 8 } });
    await open(page);
    await selectSentence(page, 1);
    await page.locator("#btnResearch").click();
    const note = page.locator(".note.kind-research").first();
    await expect(note.locator(".answer")).toContainText("Plain-English explanation");
    await expect(note.locator(".cite .tag").first()).toContainText("llama3.2");
    await expect(note.locator(".answer a.ref").first()).toHaveText("[Bill, p.9]");
    await expect(note.locator(".answer")).not.toContainText("Beyond the documents"); // web not opted in
  });

  test("web search asks first, ranks by source quality, and can be saved", async ({ page }) => {
    let dialogs = 0;
    page.on("dialog", (d) => { dialogs++; d.accept(); });
    await open(page);
    await page.keyboard.press("/");
    await page.locator("#searchInput").fill("AI Bill Senate");
    await page.locator("#webSearchBtn").click();
    await expect(page.locator("#webResults .result.web").first()).toBeVisible();
    expect(dialogs).toBe(1);
    const tiers = await page.locator("#webResults .tier").allTextContents();
    expect(tiers[0]).toBe("Official (Kenya)");
    expect(tiers.at(-1)).toMatch(/^Other/);
    await page.locator("#webResults .web-actions button").first().click();
    await page.keyboard.press("Escape");
    await page.locator("#notebookBtn").click();
    await expect(page.locator(".note.kind-web").first()).toContainText("parliament.go.ke");
  });

  test("with web opted in, the model gets web sources and they stay separate", async ({ page, context }) => {
    await seed(context, { web_ok: true, pos: { doc: "bill", idx: 8 } });
    await open(page);
    await page.locator("#notebookBtn").click();
    await page.locator("#webToggle").check();
    await page.locator("#askInput").fill("What does the Senate say about the AI Bill?");
    await page.locator("#askInput").press("Enter");
    const note = page.locator(".note.kind-ask").first();
    await expect(note.locator(".answer")).toContainText("Beyond the documents");
    await expect(note.locator(".websrc")).toContainText("Official (Kenya)");
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#exportBtn").click()]);
    const brief = fs.readFileSync(await download.path(), "utf8");
    expect(brief).toMatch(/## Sources beyond the documents[\s\S]*accessed \d{4}-\d{2}-\d{2}/);
  });

  test("worth noting: key points, keep, cross-references that land on the clause", async ({ page, context }) => {
    await seed(context, { pos: { doc: "bill", idx: 10 } });
    await open(page);
    await expect(page.locator("#insights .point").first()).toBeVisible();
    await page.locator("#insights .point .keep").first().click();
    await expect(page.locator("#pageBody .sentence.saved-hl").first()).toBeVisible();
    const xref = page.locator("#insights .chip-btn").first();
    const clause = (await xref.textContent()).match(/\d+/)[0];
    await xref.click();
    await expect(page.locator("#crumbs")).toContainText(`Clause ${clause}`);
  });
});
