// SPDX-License-Identifier: AGPL-3.0-or-later
// Accounts: signing in, first-login password, private notebooks — including two people sharing one
// device, and a change queued offline by one person never being filed under another.
import { createRequire } from "node:module";
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { ACCOUNTS_PORT, ADMIN_PASSWORD } from "../playwright.config.mjs";
import { selectSentence, unique } from "./helpers.mjs";

const BASE = `http://localhost:${ACCOUNTS_PORT}`;
test.use({ baseURL: BASE, bypassCSP: true }); // bypassCSP: only so axe can be injected

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function audit(page, selector) {
  await page.addScriptTag({ content: axeSource });
  const { violations } = await page.evaluate((sel) => window.axe.run(document.querySelector(sel), {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
  }), selector);
  return violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`);
}
test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "accounts flows run once, on desktop"));

const AMINA_PASSWORD = "maji ya mvua ni baraka";
let amina = null; // created by the admin in the first test

async function signIn(page, username, password) {
  await page.goto("/", { waitUntil: "load" });
  await page.locator("#login").waitFor();
  await page.locator("#loginUser").fill(username);
  await page.locator("#loginPass").fill(password);
  await page.locator("#loginSubmit").click();
}

async function readerReady(page) {
  await expect(page.locator("#login")).toBeHidden();
  await page.locator("#pageBody .sentence").first().waitFor();
}

/** Open page 9 of the Bill from the sidebar, as a reader would. */
async function openBillPage(page) {
  await page.locator(".doclink", { hasText: "The Artificial Intelligence Bill, 2026" }).click();
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  await expect(page.locator("#pageNo")).toContainText("Page 9 of");
}

/** Sign out; returns the "changes haven't synced" confirmation text if one was shown. */
async function signOut(page) {
  let asked = null;
  const onDialog = (d) => { asked = d.message(); d.accept(); };
  page.once("dialog", onDialog);
  await page.locator("#accountBtn").click();
  await page.locator("#signOutBtn").click();
  await page.locator("#login").waitFor();
  page.off("dialog", onDialog);
  return asked;
}

const notebookTexts = (page) => page.evaluate(async () => (await (await fetch("/api/v1/notes")).json()).notes.map((n) => n.selection));

test("the sign-in screen guards the app and is accessible", async ({ page }) => {
  await page.goto("/");
  await page.locator("#login").waitFor();
  expect(await audit(page, "#login")).toEqual([]);
  await signIn(page, "admin", "not-the-password");
  await expect(page.locator("#loginError")).toContainText("Wrong username or password");
  await page.locator("#loginPass").fill(ADMIN_PASSWORD);
  await page.locator("#loginSubmit").click();
  await readerReady(page);
  await page.locator("#accountBtn").click();
  await expect(page.locator("#accountRole")).toContainText("Administrator");
});

test("an administrator adds a person, who then chooses their own password", async ({ page, browser }) => {
  await signIn(page, "admin", ADMIN_PASSWORD);
  await readerReady(page);
  await page.locator("#accountBtn").click();
  await page.locator("#manageUsersBtn").click();
  await page.locator("#usersList .user-row").first().waitFor();
  expect(await audit(page, "#usersDialog")).toEqual([]);
  amina = unique("amina").replace(" ", "");
  await page.locator("#newUsername").fill(amina);
  await page.locator("#newDisplay").fill("Amina Wanjiru");
  await page.locator("#addUserForm button[type=submit]").click();
  const temp = await page.locator("#tempPw code").textContent();
  await expect(page.locator("#usersList")).toContainText("Hasn't chosen a password yet");

  const other = await (await browser.newContext()).newPage(); // Amina's own phone
  await signIn(other, amina, temp);
  await expect(other.locator("#passwordTitle")).toHaveText("Choose your own password");
  await expect(other.locator("#passwordCancel")).toBeHidden(); // can't skip it
  await other.locator("#pwCurrent").fill(temp);
  await other.locator("#pwNew").fill(AMINA_PASSWORD);
  await other.locator("#pwRepeat").fill(AMINA_PASSWORD);
  await other.locator("#passwordForm button[type=submit]").click();
  await readerReady(other);
});

test("two people on one device each see only their own notebook", async ({ page }) => {
  await signIn(page, amina, AMINA_PASSWORD);
  await readerReady(page);
  await openBillPage(page);
  await selectSentence(page, 1);
  const hers = await page.evaluate(() => getSelection().toString().replace(/\s+/g, " ").trim());
  await page.locator("#btnHighlight").click();
  await expect.poll(() => notebookTexts(page)).toContain(hers);
  await signOut(page);

  await signIn(page, "admin", ADMIN_PASSWORD); // same browser, same device storage
  await readerReady(page);
  expect(await notebookTexts(page)).not.toContain(hers);
  await page.locator("#notebookBtn").click();
  await expect(page.locator("#notesList")).not.toContainText(hers.slice(0, 40));
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort()))
    .toEqual(expect.arrayContaining([`bookmind-admin`, expect.stringMatching(/^bookmind-amina/)]));
});

test("a change made offline waits for its owner, even if someone else signs in first", async ({ page, context }) => {
  await signIn(page, amina, AMINA_PASSWORD);
  await readerReady(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await openBillPage(page);
  await context.setOffline(true);
  await selectSentence(page, 3);
  const queued = await page.evaluate(() => getSelection().toString().replace(/\s+/g, " ").trim());
  await page.locator("#btnHighlight").click();
  await expect(page.locator("#netText")).toContainText("to sync");
  expect(await signOut(page)).toContain("1 change hasn't reached the server yet"); // kept on the device
  await context.setOffline(false);

  await signIn(page, "admin", ADMIN_PASSWORD);
  await readerReady(page);
  await page.waitForTimeout(1500); // give any background sync time to (wrongly) send it
  expect(await notebookTexts(page)).not.toContain(queued);
  await signOut(page);

  await signIn(page, amina, AMINA_PASSWORD);
  await readerReady(page);
  await expect.poll(() => notebookTexts(page), { timeout: 15000 }).toContain(queued); // synced as Amina
});

test("disabling an account signs that person out everywhere", async ({ page, browser }) => {
  const hers = await (await browser.newContext()).newPage();
  await signIn(hers, amina, AMINA_PASSWORD);
  await readerReady(hers);

  await signIn(page, "admin", ADMIN_PASSWORD);
  await readerReady(page);
  await page.locator("#accountBtn").click();
  await page.locator("#manageUsersBtn").click();
  await page.getByRole("button", { name: `Disable: ${amina}` }).click();
  await expect(page.locator("#usersList")).toContainText("Disabled");

  await hers.locator("#searchBtn").click();
  await hers.locator("#searchInput").fill("commissioner"); // any server call now finds the session gone
  await expect(hers.locator("#login")).toBeVisible();
  await hers.locator("#loginUser").fill(amina);
  await hers.locator("#loginPass").fill(AMINA_PASSWORD);
  await hers.locator("#loginSubmit").click();
  await expect(hers.locator("#loginError")).toContainText("disabled");
});
