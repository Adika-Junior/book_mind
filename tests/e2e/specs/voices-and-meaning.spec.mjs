// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "@playwright/test";
import { open, seed } from "./helpers.mjs";

test("reads aloud with a Piper natural voice, and replays the page offline from cache", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "one profile is enough for audio");
  const voices = await (await context.request.get("/api/v1/tts/voices")).json();
  test.skip(!voices.voices.length, "no Piper voices installed on the test server (python tools/voices.py get en-us-lessac-low)");
  await seed(context, { pos: { doc: "bill", idx: 3 } });
  await open(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  const select = page.locator("#voiceSelect");
  await expect(select.locator('optgroup[label="Natural voices (Piper)"] option').first()).toBeAttached();
  await expect(select).toHaveValue(/^piper:/); // preferred by default when the server has one

  const audio = page.waitForResponse((r) => r.url().includes("/api/v1/tts?") && r.status() === 200);
  await page.locator("#playBtn").click();
  expect((await audio).headers()["content-type"]).toBe("audio/wav");
  await expect(page.locator("#pageBody .sentence.reading")).toHaveCount(1);
  // It advances by itself: sentence 2 starts after sentence 1's audio ends.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("#pageBody .sentence")].findIndex((s) => s.classList.contains("reading"))), { timeout: 30000 }).toBeGreaterThan(0);
  await page.locator("#playBtn").click(); // pause

  // Offline: the sentences already heard come from the service worker's audio cache.
  await context.setOffline(true);
  const cachedFirst = await page.evaluate(async () => {
    const s = document.querySelector("#pageBody .sentence").textContent.replace(/\s+/g, " ").trim();
    const v = document.getElementById("voiceSelect").value.slice(6);
    const r = await fetch(`/api/v1/tts?voice=${encodeURIComponent(v)}&text=${encodeURIComponent(s)}`);
    return [r.status, r.headers.get("content-type")];
  });
  expect(cachedFirst).toEqual([200, "audio/wav"]);
  await context.setOffline(false);
});

test("offline search finds pages by meaning, not only by shared words", async ({ page, context }, info) => {
  test.skip(info.project.name !== "phone", "offline search on the phone profile");
  const pack = await context.request.get("/api/v1/semantic");
  test.skip(pack.status() !== 200, "meaning search not enabled on the test server");
  const loaded = page.waitForResponse((r) => r.url().endsWith("/api/v1/semantic") && r.ok());
  await open(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await loaded;
  await page.waitForTimeout(500);

  await context.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await page.locator("#pageBody .sentence").first().waitFor();
  await page.waitForTimeout(1500); // the pack is read back from the service worker cache when idle
  await page.locator("#searchBtn").click();
  await page.locator("#searchInput").fill("punishment for misusing AI"); // the documents say "offence" and "penalty"
  await expect(page.locator("#searchMeta")).toContainText("by words and meaning");
  const first = page.locator("#searchResults .result").first();
  await expect(first.locator(".tag-meaning")).toHaveText("Similar meaning");
  await expect(first).toContainText(/offence|penalt/i);
  await context.setOffline(false);
});
