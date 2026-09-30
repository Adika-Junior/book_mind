// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { open, seed, selectSentence, unique } from "./helpers.mjs";

test("research workspace: session, highlight, own note, ask, filter, export", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "full workflow on desktop; phone covers offline sync");
  const session = unique("Penalties");
  await seed(context, { pos: { doc: "bill", idx: 10 } });
  await open(page);
  await page.locator("#notebookBtn").click();
  await page.locator("#newSessionBtn").click();
  await page.locator("#newSessionName").fill(session);
  await page.locator("#newSessionName").press("Enter");
  await expect(page.locator("#sessionSelect")).toHaveValue(session);

  await selectSentence(page, 1);
  await page.locator("#btnHighlight").click();
  await expect(page.locator("#pageBody mark.anchor.hl").first()).toBeVisible();

  await selectSentence(page, 3);
  await page.locator("#btnNote").click();
  await page.locator(".comment-edit").fill("Compare with the Data Protection Act fines.");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".note.kind-note .comment")).toContainText("Data Protection Act");

  await page.locator("#askInput").fill("Who appoints the Artificial Intelligence Commissioner?");
  await page.locator("#askInput").press("Enter");
  await expect(page.locator(".note.kind-ask .answer")).toContainText("[Bill, p.");

  await page.locator('#nbFilters [data-f="highlights"]').click();
  await expect(page.locator("#notesList .note")).toHaveCount(1);
  await page.locator('#nbFilters [data-f="all"]').click();
  await page.locator("#nbQuery").fill("Data Protection");
  await expect(page.locator("#notesList .note")).toHaveCount(1);
  await page.locator("#nbQuery").fill("");

  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#exportBtn").click()]);
  const brief = fs.readFileSync(await download.path(), "utf8");
  expect(brief).toContain(`# Research brief: ${session}`);
  expect(brief).toContain("**My note:** Compare with the Data Protection Act fines.");
  expect(brief).toContain("## Verification checklist");

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("#pageBody mark.anchor").first()).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/v1/notes")).json()).sessions.find((s) => s.name === session)?.count).toBe(3);
});

test("a highlight made offline syncs when the connection returns", async ({ page, context }, info) => {
  test.skip(info.project.name !== "phone", "offline sync on the phone profile");
  await seed(context, { pos: { doc: "digest", idx: 8 } });
  await open(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1000);
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await selectSentence(page, 2);
  await page.locator("#btnHighlight").click();
  await expect(page.locator("#netText")).toContainText("to sync");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#netChip")).toBeHidden({ timeout: 15_000 });
});
