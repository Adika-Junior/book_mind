// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "@playwright/test";
import { open, seed, selectPhrase } from "./helpers.mjs";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));

test("a highlight marks exactly the selected words, across sentences, and survives reload", async ({ page, context }) => {
  await seed(context, { pos: { doc: "digest", idx: 2 } });
  await open(page);
  // Starts mid-sentence and runs into the next sentence.
  const phrase = await page.evaluate(() => {
    const spans = [...document.querySelectorAll("#pageBody p .sentence")];
    const a = spans.find((s, i) => spans[i + 1] && s.parentElement === spans[i + 1].parentElement && s.textContent.split(" ").length > 8);
    const b = a.nextElementSibling;
    const tail = a.textContent.trim().split(" ").slice(-4).join(" ");
    const head = b.textContent.trim().split(" ").slice(0, 3).join(" ");
    return `${tail} ${head}`;
  });
  await selectPhrase(page, phrase);
  await page.locator("#btnHighlight").click();
  // Marks cover the words exactly (the gap between two sentences sits between two marks).
  const squeeze = (t) => t.replace(/\s+/g, "");
  const marked = async () => squeeze((await page.locator("#pageBody mark.anchor.hl").allTextContents()).join(""));
  await expect.poll(marked).toBe(squeeze(phrase));
  await page.reload({ waitUntil: "networkidle" });
  await expect.poll(marked).toBe(squeeze(phrase));
});

test("a repeated phrase is anchored to the occurrence that was selected", async ({ page, context }) => {
  await seed(context, { pos: { doc: "bill", idx: 11 } });
  await open(page);
  const phrase = "the Artificial Intelligence Commissioner";
  const count = await page.evaluate((p) => document.getElementById("pageBody").textContent.split(p).length - 1, phrase);
  test.skip(count < 2, "phrase not repeated on this page");
  await selectPhrase(page, phrase, 1);
  await page.locator("#btnHighlight").click();
  await page.reload({ waitUntil: "networkidle" });
  const which = await page.evaluate((p) => {
    const body = document.getElementById("pageBody");
    const mark = body.querySelector("mark.anchor.hl");
    const before = document.createRange();
    before.setStart(body, 0);
    before.setEndBefore(mark);
    return before.toString().split(p).length - 1; // occurrences before the mark
  }, phrase);
  expect(which).toBe(1);
});
