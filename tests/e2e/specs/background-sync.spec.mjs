// SPDX-License-Identifier: AGPL-3.0-or-later
// A note written offline reaches the server even though the app was closed before the connection
// came back: the browser wakes the service worker (Background Sync) and it replays the IndexedDB outbox.
import { expect, test } from "@playwright/test";
import { open, seed, selectSentence } from "./helpers.mjs";

/** Ask Chromium to fire a Background Sync event at our service worker, as it does when the
 *  network returns. Done from an unrelated tab: no BookMind page is open. */
async function fireSync(context, origin, tag, periodic = false) {
  const probe = await context.newPage();
  const cdp = await context.newCDPSession(probe);
  const registrations = [];
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => registrations.push(...e.registrations));
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrations.some((r) => r.scopeURL.startsWith(origin) && !r.isDeleted)).toBe(true);
  const reg = registrations.find((r) => r.scopeURL.startsWith(origin) && !r.isDeleted);
  await cdp.send(periodic ? "ServiceWorker.dispatchPeriodicSyncEvent" : "ServiceWorker.dispatchSyncEvent",
    { origin, registrationId: reg.registrationId, tag, ...(periodic ? {} : { lastChance: false }) });
  return probe;
}

test("a note made offline syncs after the app is closed", async ({ page, context, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "service-worker behaviour is the same on both profiles");
  await seed(context, { pos: { doc: "strategy", idx: 6 } });
  await open(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  await context.setOffline(true);
  await selectSentence(page, 2);
  const selection = await page.evaluate(() => getSelection().toString().replace(/\s+/g, " ").trim());
  await page.locator("#btnHighlight").click();
  await expect(page.locator("#netText")).toContainText("to sync");
  await page.close(); // the app is closed while still offline: nothing could be sent
  const serverHas = async () => (await (await context.request.get("/api/v1/notes")).json()).notes.some((n) => n.selection === selection);
  expect(await serverHas()).toBe(false);

  await context.setOffline(false);
  const probe = await fireSync(context, new URL(baseURL).origin, "bookmind-sync");
  await expect.poll(serverHas, { timeout: 15000 }).toBe(true);
  await probe.close();

  // Reopening shows it as synced and the outbox is empty.
  const again = await context.newPage();
  await open(again);
  await again.locator("#notebookBtn").click();
  await expect(again.locator("#netChip")).toBeHidden();
  expect(await again.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("bookmind");
    req.onsuccess = () => { const r = req.result.transaction("outbox").objectStore("outbox").count(); r.onsuccess = () => resolve(r.result); };
  }))).toBe(0);
});

test("periodic sync pulls notes made on another device while the app is closed", async ({ page, context, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "service-worker behaviour is the same on both profiles");
  await open(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.close();

  // "Another device" writes a note straight to the server.
  const now = Date.now();
  const id = `other-device-${now}`;
  const res = await context.request.put(`/api/v1/notes/${id}`, {
    data: { doc: "bill", doc_short: "Bill", page: 3, mode: "note", selection: "Written on my phone", answer: "", status: "done", created_at: now, updated_at: now, comment: "from the phone" },
  });
  expect(res.ok()).toBe(true);

  const probe = await fireSync(context, new URL(baseURL).origin, "bookmind-refresh", true);
  // The worker stored it in IndexedDB — no page did.
  await probe.goto("/healthz");
  await expect.poll(() => probe.evaluate((id) => new Promise((resolve) => {
    const req = indexedDB.open("bookmind");
    req.onsuccess = () => {
      if (!req.result.objectStoreNames.contains("notes")) { resolve(false); return; }
      const r = req.result.transaction("notes").objectStore("notes").get(id);
      r.onsuccess = () => resolve(!!r.result);
    };
  }), id), { timeout: 15000 }).toBe(true);
});
