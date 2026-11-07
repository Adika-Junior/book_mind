// SPDX-License-Identifier: AGPL-3.0-or-later
// Accounts in the app: who is using this device, signing in and out, changing a password, and (for
// administrators) managing accounts. Every person has a private notebook — on the server (notes are
// owned) and on the device (store.js keeps one database per account).

import { api, HttpError } from "./net.js";

const $ = (id) => document.getElementById(id);
const CACHE = "bm_account"; // last signed-in identity on this device, so the app opens offline
let toast = (msg) => console.info(msg);
let current = null;

const remember = (me) => { try { localStorage.setItem(CACHE, JSON.stringify(me)); } catch { /* blocked */ } };
const remembered = () => { try { return JSON.parse(localStorage.getItem(CACHE) || "null"); } catch { return null; } };
const forget = () => { try { localStorage.removeItem(CACHE); } catch { /* blocked */ } };
// Signed out while offline: the server session is still valid until we can tell it otherwise.
const PENDING_SIGNOUT = "bm_signout_pending";
const flag = { get: () => { try { return localStorage.getItem(PENDING_SIGNOUT) === "1"; } catch { return false; } },
  set: (on) => { try { if (on) localStorage.setItem(PENDING_SIGNOUT, "1"); else localStorage.removeItem(PENDING_SIGNOUT); } catch { /* blocked */ } } };

/** End the server session; if that can't happen now, remember to do it before anything else. */
async function endServerSession() {
  try {
    await api("/api/v1/auth/logout", { method: "POST", timeout: 6000 });
    flag.set(false);
    return true;
  } catch {
    flag.set(true);
    return false;
  }
}

const errorText = (err, fallback) => (err instanceof HttpError ? err.message : !navigator.onLine ? "You're offline. Connect to the internet and try again." : fallback);

function showError(el, text) { el.textContent = text; el.hidden = !text; }

/** Trap Tab inside an open dialog and close it with Escape (unless it must be completed). */
function modal(root, { onEscape } = {}) {
  const focusables = () => [...root.querySelectorAll("input, select, button, [href], textarea")].filter((el) => !el.disabled && el.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === "Escape" && onEscape) { e.preventDefault(); onEscape(); }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener("keydown", onKey);
  return () => root.removeEventListener("keydown", onKey);
}

/* ------------------------------------------------------------------ sign-in */

/** Show the sign-in screen until someone signs in. Resolves with the server's user record. */
function signIn({ notice = "" } = {}) {
  return new Promise((resolve) => {
    const screen = $("login"), form = $("loginForm"), err = $("loginError"), submit = $("loginSubmit");
    screen.hidden = false;
    document.body.classList.add("signed-out");
    showError(err, notice);
    $("loginUser").value = (remembered() && remembered().user && remembered().user.username) || "";
    ($("loginUser").value ? $("loginPass") : $("loginUser")).focus();
    const release = modal(screen);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const username = $("loginUser").value.trim(), password = $("loginPass").value;
      if (!username || !password) { showError(err, "Enter your username and password."); return; }
      submit.disabled = true;
      submit.textContent = "Signing in…";
      try {
        const res = await api("/api/v1/auth/login", { method: "POST", body: { username, password } });
        $("loginPass").value = "";
        screen.hidden = true;
        document.body.classList.remove("signed-out");
        release();
        resolve(res.user);
      } catch (error) {
        const wait = error instanceof HttpError && error.headers && error.headers.get("Retry-After");
        showError(err, errorText(error, "Couldn't reach BookMind. Try again.") + (wait && error.status === 429 ? ` (about ${wait}s)` : ""));
        $("loginPass").select();
      } finally {
        submit.disabled = false;
        submit.textContent = "Sign in";
      }
    };
  });
}

/* ------------------------------------------------------------------ password */

/** Change password. `forced`: a temporary password must be replaced before anything else. */
export function changePassword({ forced = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $("passwordDialog"), form = $("passwordForm"), err = $("passwordError");
    $("passwordTitle").textContent = forced ? "Choose your own password" : "Change your password";
    $("passwordIntro").textContent = (forced ? "You signed in with a one-time password. " : "") +
      "Use at least 10 characters — a short phrase you'll remember works well.";
    $("passwordCancel").hidden = forced;
    for (const id of ["pwCurrent", "pwNew", "pwRepeat"]) $(id).value = "";
    showError(err, "");
    dlg.hidden = false;
    $("pwCurrent").focus();
    const close = (user) => { dlg.hidden = true; release(); resolve(user); };
    const release = modal(dlg, { onEscape: forced ? null : () => close(null) });
    $("passwordCancel").onclick = () => close(null);
    form.onsubmit = async (e) => {
      e.preventDefault();
      if ($("pwNew").value !== $("pwRepeat").value) { showError(err, "The two new passwords don't match."); $("pwRepeat").focus(); return; }
      try {
        const res = await api("/api/v1/auth/password", { method: "POST", body: { current: $("pwCurrent").value, new: $("pwNew").value } });
        toast("Password changed. You're still signed in here; other devices will ask you to sign in again.");
        close(res.user);
      } catch (error) {
        showError(err, errorText(error, "Couldn't change the password. Try again."));
      }
    };
  });
}

/* ------------------------------------------------------------------ who is using this device */

/**
 * Work out who is using the app, asking them to sign in if needed.
 * @returns {Promise<{mode:string, user:object, legacy_owner:string, offline?:boolean}>}
 */
export async function establish(opts = {}) {
  if (opts.toast) toast = opts.toast;
  let session, user;
  // A sign-out that happened offline must reach the server before anyone is let back in.
  const signedOutOffline = flag.get() && !(await endServerSession());
  try {
    if (signedOutOffline) throw new Error("sign-out still pending");
    session = await api("/api/v1/auth/session", { timeout: 6000 });
    user = session.user;
  } catch {
    const cached = remembered();
    if (cached) return (current = { ...cached, offline: true }); // read and take notes offline as before
    // Nobody is signed in on this device and there's no connection: the sign-in screen still
    // appears, and works as soon as the connection is back.
    user = await signIn({ notice: "You're offline. Signing in needs an internet connection — try again once you're back online." });
    session = await api("/api/v1/auth/session", { timeout: 6000 }).catch(() => ({ mode: "accounts", legacy_owner: null }));
  }
  if (session.mode === "accounts" && !user) user = await signIn();
  if (user && user.must_change) user = await changePassword({ forced: true });
  current = { mode: session.mode, user, legacy_owner: session.legacy_owner };
  remember(current);
  return current;
}

/** Called when the server says the session ended (signed out elsewhere, expired, disabled). */
export async function reauthenticate(code) {
  if (code === "password_change_required") { await changePassword({ forced: true }); return current && current.user; }
  toast("Please sign in again.");
  const user = await signIn();
  const same = current && current.user && current.user.username === user.username;
  if (!same) { location.reload(); return null; } // a different person: start clean with their notebook
  if (user.must_change) await changePassword({ forced: true });
  remember(current);
  return user;
}

/* ------------------------------------------------------------------ account menu */

export function mountMenu(me, { pendingChanges, beforeSignOut, afterSignOut }) {
  if (me.mode !== "accounts") return; // single-user mode: nothing to show
  const btn = $("accountBtn"), menu = $("accountMenu");
  btn.hidden = false;
  btn.setAttribute("aria-label", `Your account: ${me.user.display_name || me.user.username}`);
  $("accountName").textContent = me.user.display_name || me.user.username;
  $("accountRole").textContent = `${me.user.username} · ${me.user.role === "admin" ? "Administrator" : "Reader"}${me.offline ? " · offline" : ""}`;
  $("manageUsersBtn").hidden = me.user.role !== "admin";
  const items = () => [...menu.querySelectorAll("button:not([hidden])")];
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const open = () => { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); items()[0].focus(); };
  btn.onclick = () => (menu.hidden ? open() : close());
  menu.addEventListener("keydown", (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === "Escape") { close(); btn.focus(); }
    if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
  });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(); });
  $("changePwBtn").onclick = async () => { close(); await changePassword(); btn.focus(); };
  $("manageUsersBtn").onclick = () => { close(); openUsers(me); };
  $("signOutBtn").onclick = async () => {
    close();
    await beforeSignOut();
    const pending = await pendingChanges();
    if (pending && !confirm(`${pending} change${pending === 1 ? " hasn't" : "s haven't"} reached the server yet. ` +
      "They'll stay on this device and sync the next time you sign in here. Sign out anyway?")) return;
    await endServerSession(); // offline: done before the next sign-in on this device
    forget();
    await afterSignOut();
    location.reload();
  };
}

/* ------------------------------------------------------------------ administration */

const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never");

async function openUsers(me) {
  const dlg = $("usersDialog"), err = $("usersError"), list = $("usersList"), temp = $("tempPw");
  dlg.hidden = false;
  showError(err, "");
  temp.hidden = true;
  const close = () => { dlg.hidden = true; release(); $("accountBtn").focus(); };
  const release = modal(dlg, { onEscape: close });
  $("usersClose").onclick = close;
  $("newUsername").focus();

  const showTemp = (who, password) => {
    temp.hidden = false;
    temp.innerHTML = "";
    const p = document.createElement("p");
    p.append(`Share this one-time password with ${who} privately (not by email if you can avoid it): `);
    const code = document.createElement("code");
    code.textContent = password;
    p.append(code, ". They'll choose their own password when they sign in.");
    const copy = Object.assign(document.createElement("button"), { type: "button", className: "btn small ghost", textContent: "Copy" });
    copy.onclick = async () => { try { await navigator.clipboard.writeText(password); toast("Copied."); } catch { toast("Select the password and copy it."); } };
    temp.append(p, copy);
  };

  async function refresh() {
    let data;
    try { data = await api("/api/v1/admin/users"); } catch (error) { showError(err, errorText(error, "Couldn't load accounts.")); return; }
    list.textContent = "";
    for (const u of data.users) {
      const row = document.createElement("div");
      row.className = "user-row" + (u.disabled ? " off" : "");
      const who = document.createElement("div");
      who.className = "who";
      const name = document.createElement("strong");
      name.textContent = `${u.display_name}${u.username === me.user.username ? " (you)" : ""}`;
      const meta = document.createElement("span");
      const status = u.disabled ? "Disabled" : u.locked ? "Locked after failed sign-ins" : u.must_change ? "Hasn't chosen a password yet" : `Last signed in ${when(u.last_login_at)}`;
      meta.textContent = `${u.username} · ${u.role === "admin" ? "Administrator" : "Reader"} · ${status}`;
      who.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "actions";
      const action = (label, fn) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "linkbtn", textContent: label });
        b.setAttribute("aria-label", `${label}: ${u.username}`);
        b.onclick = async () => {
          showError(err, "");
          try { await fn(); await refresh(); } catch (error) { showError(err, errorText(error, "That didn't work. Try again.")); }
        };
        actions.appendChild(b);
      };
      action("Reset password", async () => {
        const res = await api(`/api/v1/admin/users/${u.username}`, { method: "PATCH", body: { reset_password: true } });
        showTemp(u.display_name, res.temporary_password);
      });
      if (u.username !== me.user.username) {
        action(u.disabled ? "Enable" : "Disable", () => api(`/api/v1/admin/users/${u.username}`, { method: "PATCH", body: { disabled: !u.disabled } }));
        action(u.role === "admin" ? "Make reader" : "Make admin", () => api(`/api/v1/admin/users/${u.username}`, { method: "PATCH", body: { role: u.role === "admin" ? "reader" : "admin" } }));
        action("Delete", async () => {
          if (!confirm(`Delete ${u.display_name} (${u.username}) and everything in their notebook? This can't be undone.`)) return;
          const res = await api(`/api/v1/admin/users/${u.username}`, { method: "DELETE" });
          toast(`Deleted ${u.username} and ${res.deleted_notes} note${res.deleted_notes === 1 ? "" : "s"}.`);
        });
      }
      row.append(who, actions);
      list.appendChild(row);
    }
  }

  $("addUserForm").onsubmit = async (e) => {
    e.preventDefault();
    showError(err, "");
    const username = $("newUsername").value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) { showError(err, "Usernames use lowercase letters, numbers, dots and dashes (2–32 characters)."); $("newUsername").focus(); return; }
    try {
      const display = $("newDisplay").value.trim();
      const res = await api("/api/v1/admin/users", { method: "POST", body: { username, display_name: display, role: $("newRole").value } });
      showTemp(display || username, res.temporary_password);
      $("newUsername").value = $("newDisplay").value = "";
      await refresh();
    } catch (error) {
      showError(err, errorText(error, "Couldn't add the account."));
    }
  };
  await refresh();
}
