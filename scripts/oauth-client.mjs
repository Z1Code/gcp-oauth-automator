#!/usr/bin/env node
/**
 * Google OAuth 2.0 client automation via Playwright.
 * Cross-platform: Windows, macOS, Linux.
 *
 * MODES:
 *   create  <project-id> <app-name> <redirect-uri> <support-email>
 *           Creates a new OAuth Web Client ID (with consent screen if needed).
 *
 *   renew   <project-id>
 *           Adds a new secret to the first OAuth client in the project.
 *           Use when credentials are lost, expired, or need rotating.
 *
 * OUTPUT (stdout, JSON):
 *   { "clientId": "...", "clientSecret": "GOCSPX-..." }
 *
 * First run: Chrome opens visibly — sign in once. Session saved to chrome-profile/.
 * Subsequent runs: fully automatic (session reused).
 *
 * Requirements:
 *   - Node.js 18+
 *   - npm install playwright
 *   - Google Chrome installed
 */

import { chromium } from "playwright";
import os from "os";
import path from "path";
import { spawnSync, spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";

// ─── Platform detection ────────────────────────────────────────────────────────

const IS_WIN   = process.platform === "win32";
const IS_MAC   = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

/** Find Google Chrome executable — returns path or throws. */
function findChrome() {
  if (IS_WIN) {
    const candidates = [
      path.join(process.env["ProgramFiles"]  ?? "C:\\Program Files",        "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["LOCALAPPDATA"]  ?? "", "Google\\Chrome\\Application\\chrome.exe"),
    ];
    const found = candidates.find(existsSync);
    if (found) return found;
    throw new Error("Chrome not found. Install from https://www.google.com/chrome/");
  }
  if (IS_MAC) {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(mac)) return mac;
    throw new Error("Chrome not found at /Applications/Google Chrome.app");
  }
  // Linux
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error("Chrome not found. Install via: sudo apt install google-chrome-stable");
}

/** Kill any Chrome instance using our debug port. */
function killChromeOnPort(port) {
  if (IS_WIN) {
    // Find PID using the debug port via netstat, then kill it
    const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    const line = netstat.stdout?.split("\n").find(l => l.includes(`:${port}`) && l.includes("LISTENING"));
    if (line) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid) spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
    }
  } else {
    // Mac / Linux
    const pid = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" }).stdout.trim();
    if (pid) {
      for (const p of pid.split("\n").filter(Boolean)) {
        spawnSync("kill", ["-9", p], { stdio: "ignore" });
      }
    }
  }
}

/** Check if the Chrome debug port is listening. */
function isPortReady(port) {
  const r = spawnSync(
    IS_WIN ? "powershell" : "curl",
    IS_WIN
      ? ["-Command", `(New-Object System.Net.Sockets.TcpClient).Connect('127.0.0.1', ${port}); $true`]
      : ["-s", "--max-time", "1", `http://127.0.0.1:${port}/json/version`],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
  if (IS_WIN) return r.status === 0;
  return r.stdout?.includes("webSocketDebuggerUrl") ?? false;
}

/** Open a URL in the system browser (for error messages). */
function openBrowser(url) {
  if (IS_WIN) spawnSync("start", [url], { shell: true });
  else if (IS_MAC) spawnSync("open", [url]);
  else spawnSync("xdg-open", [url]);
}

// ─── Paths ─────────────────────────────────────────────────────────────────────

const SKILL_DIR       = path.join(os.homedir(), ".claude-skills", "oauth");
const CHROME_PROFILE  = path.join(SKILL_DIR, "chrome-profile");
const DEBUG_PORT      = 9222;
const LOG_FILE        = IS_WIN ? path.join(os.tmpdir(), "oauth-setup.log") : "/tmp/oauth-setup.log";

mkdirSync(CHROME_PROFILE, { recursive: true });

// ─── CLI args ──────────────────────────────────────────────────────────────────

const [, , MODE, ...args] = process.argv;

if (MODE !== "create" && MODE !== "renew") {
  console.error("Usage:");
  console.error("  node oauth-client.mjs create <project-id> <app-name> <redirect-uri> <support-email>");
  console.error("  node oauth-client.mjs renew  <project-id>");
  process.exit(1);
}

const PROJECT_ID    = args[0];
const APP_NAME      = args[1];
const REDIRECT_URI  = args[2];
const SUPPORT_EMAIL = args[3];

if (!PROJECT_ID) { console.error("Missing project-id"); process.exit(1); }
if (MODE === "create" && (!APP_NAME || !REDIRECT_URI || !SUPPORT_EMAIL)) {
  console.error("create requires: <project-id> <app-name> <redirect-uri> <support-email>");
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, description) {
  for (const sel of selectors) {
    try { await page.locator(sel).first().click({ timeout: 5000 }); return true; } catch {}
  }
  throw new Error(`Could not find: ${description}`);
}

async function tryFill(page, selectors, value, description) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ timeout: 5000 });
      await loc.fill(value);
      return true;
    } catch {}
  }
  throw new Error(`Could not find input: ${description}`);
}

async function screenshot(page, name) {
  const p = IS_WIN ? path.join(os.tmpdir(), `gcp-oauth-${name}.png`) : `/tmp/gcp-oauth-${name}.png`;
  await page.screenshot({ path: p }).catch(() => {});
  console.error(`[screenshot] ${p}`);
}

// ─── Chrome launch ─────────────────────────────────────────────────────────────

const CHROME_PATH = findChrome();
console.error(`[boot] Chrome: ${CHROME_PATH}`);
console.error(`[boot] Profile: ${CHROME_PROFILE}`);

// Kill any Chrome already on that debug port
killChromeOnPort(DEBUG_PORT);
await new Promise(r => setTimeout(r, 1000));

// Launch Chrome with automation profile + debug port
const chromeArgs = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${CHROME_PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
];

console.error(`[boot] Launching Chrome on port ${DEBUG_PORT}...`);
if (IS_MAC) {
  // macOS: use 'open' so the window appears in the GUI session (works over SSH too)
  spawnSync("open", ["-a", "Google Chrome", "--args", ...chromeArgs], { encoding: "utf8" });
} else {
  // Windows / Linux: spawn directly, detach so it keeps running
  const proc = spawn(CHROME_PATH, chromeArgs, {
    detached: true,
    stdio: "ignore",
    ...(IS_WIN ? { windowsHide: false } : {}),
  });
  proc.unref();
}

// Wait for debug port to be ready (up to 25s)
console.error("[boot] Waiting for Chrome debug port...");
let portReady = false;
for (let i = 0; i < 25; i++) {
  await new Promise(r => setTimeout(r, 1000));
  if (isPortReady(DEBUG_PORT)) {
    portReady = true;
    console.error(`[boot] Ready after ${i + 1}s`);
    break;
  }
}
if (!portReady) throw new Error(`Chrome debug port ${DEBUG_PORT} not ready after 25s`);

// Connect Playwright via CDP
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const context  = browser.contexts()[0] ?? await browser.newContext();
const page     = await context.newPage();

// ─── Sign-in helper ────────────────────────────────────────────────────────────

async function ensureSignedIn(targetUrl) {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (page.url().includes("accounts.google.com")) {
    console.error("");
    console.error("⚠️  Chrome session expired — sign-in required:");
    console.error("   → A Chrome window is now open.");
    console.error("   → Sign in with your Google Cloud account.");
    console.error("   → Waiting up to 3 minutes...");
    console.error("");
    await page.waitForURL(url => !url.toString().includes("accounts.google.com"), { timeout: 180000 });
    console.error("[auth] Signed in — re-navigating...");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
  }
}

// ─── Shared: extract secret from existing client ───────────────────────────────

async function addAndExtractSecret() {
  await ensureSignedIn(`https://console.cloud.google.com/auth/clients?project=${PROJECT_ID}`);
  await page.waitForTimeout(4000);
  await screenshot(page, "clients-list");

  // Click first (newest) client link — list is sorted date desc
  const clientHref = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"))
      .filter(a => /auth\/clients\/\d/.test(a.href));
    if (links[0]) { links[0].click(); return links[0].href; }
    return null;
  }).catch(() => null);
  console.error(`[secret] Clicked: ${clientHref}`);
  await page.waitForTimeout(4000);
  await screenshot(page, "client-detail");

  // Extract Client ID from URL or DOM
  let clientId = "";
  const urlMatch = page.url().match(/auth\/clients\/(\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com)/);
  if (urlMatch) clientId = urlMatch[1];
  if (!clientId) {
    const m = (await page.evaluate(() => document.body.innerHTML).catch(() => ""))
      .match(/(\d{12,}-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    if (m) clientId = m[1];
  }
  console.error(`[secret] Client ID: ${clientId?.substring(0, 50)}`);

  // Click "Add secret" — Google masks the original; this generates a new visible one
  const addSecretBtn = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button, a"))
      .find(b => /add secret|agregar secreto|nuevo secreto/i.test(b.textContent?.trim() ?? ""));
    if (btn) { btn.click(); return btn.textContent?.trim(); }
    return null;
  }).catch(() => null);
  console.error(`[secret] Add secret: ${addSecretBtn}`);
  await page.waitForTimeout(3000);
  await screenshot(page, "after-add-secret");

  const html = await page.evaluate(() => document.body.innerHTML).catch(() => "");
  const secretMatch = html.match(/(GOCSPX-[A-Za-z0-9_-]{20,})/);
  return { clientId, clientSecret: secretMatch?.[1] ?? "" };
}

// ─── MODE: renew ──────────────────────────────────────────────────────────────

if (MODE === "renew") {
  try {
    console.error(`[renew] Project: ${PROJECT_ID}`);
    const creds = await addAndExtractSecret();
    if (!creds.clientId)     throw new Error("Could not find OAuth client. Check screenshot: gcp-oauth-clients-list.png");
    if (!creds.clientSecret) throw new Error("Could not extract secret. Check screenshot: gcp-oauth-after-add-secret.png");
    console.log(JSON.stringify(creds));
  } catch (err) {
    await screenshot(page, "error");
    console.error("ERROR:", err.message);
    process.exit(1);
  } finally {
    await context.close().catch(() => {});
    // Reopen Chrome to user's normal session
    if (IS_MAC) spawnSync("open", ["-a", "Google Chrome"], { encoding: "utf8" });
    else if (IS_WIN) spawnSync("start", ["chrome"], { shell: true });
  }
  process.exit(0);
}

// ─── MODE: create ─────────────────────────────────────────────────────────────

try {
  console.error(`[create] Project: ${PROJECT_ID}, App: ${APP_NAME}`);
  await ensureSignedIn(`https://console.cloud.google.com/apis/credentials?project=${PROJECT_ID}`);
  await screenshot(page, "step1-credentials");

  // Accept terms if shown
  try {
    const accept = page.locator('button:has-text("Accept"), button:has-text("I agree")');
    if (await accept.first().isVisible({ timeout: 3000 })) { await accept.first().click(); await page.waitForTimeout(2000); }
  } catch {}

  // Navigate to create client
  console.error("[create] Navigating to create client...");
  await page.goto(
    `https://console.cloud.google.com/auth/clients/create?project=${PROJECT_ID}`,
    { waitUntil: "domcontentloaded", timeout: 30000 }
  );
  await page.waitForTimeout(3000);
  await screenshot(page, "step2-create");

  // Wait for Angular to fully render before checking for consent warning
  await page.waitForTimeout(12000);
  const consentWarning = await page
    .locator('button:has-text("Configurar pantalla de consentimiento"), button:has-text("Configure consent screen")')
    .first().isVisible().catch(() => false);
  console.error(`[create] Consent warning: ${consentWarning}`);

  if (consentWarning) {
    console.error("[create] Configuring consent screen...");
    await page.locator('button:has-text("Configurar pantalla de consentimiento"), button:has-text("Configure consent screen")').first().click();
    await page.waitForTimeout(7000);
    await screenshot(page, "step2-branding");

    // Fill app name
    try {
      const nameInput = page.locator('input[formcontrolname="displayName"]').first();
      await nameInput.waitFor({ state: "visible", timeout: 8000 });
      if ((await nameInput.inputValue().catch(() => "")).trim() !== APP_NAME.trim()) await nameInput.fill(APP_NAME);
      console.error("[create] App name filled.");
    } catch { console.error("[create] Could not fill app name"); }

    // Fill support email via cfc-select dropdown
    try {
      await page.evaluate(() => {
        const el = document.querySelector("cfc-select") ||
          document.querySelector('[role="combobox"][aria-haspopup="listbox"]') ||
          document.querySelector(".cfc-select-trigger");
        if (el) { el.scrollIntoView({ behavior: "instant" }); el.click(); }
      });
      await page.waitForTimeout(800);
      const opts = await page.locator("cfc-option, [role=option]").allTextContents().catch(() => []);
      if (opts.length > 0) {
        const target = page.locator("cfc-option, [role=option]").filter({ hasText: SUPPORT_EMAIL });
        if (await target.count().catch(() => 0) > 0) await target.first().click();
        else await page.locator("cfc-option, [role=option]").first().click();
        console.error("[create] Support email selected.");
      }
    } catch (e) { console.error(`[create] Email error: ${e.message}`); }

    // Run wizard steps
    let wizardDone = false;
    for (let step = 1; step <= 8 && !wizardDone; step++) {
      await page.waitForTimeout(1500);
      const elems = await page.evaluate(() => {
        const vis = el => el.offsetWidth > 0 && el.offsetHeight > 0;
        return {
          radios: Array.from(document.querySelectorAll("mat-radio-button")).filter(vis).length,
          contactEmails: Array.from(document.querySelectorAll("input[type=email], input[type=text]"))
            .filter(el => vis(el) && el.id !== "mat-input-0" && !/buscar|search|nombre|displayname/i.test(el.getAttribute("aria-label") || el.placeholder || "")).length,
          checkboxes: Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(vis).length,
        };
      }).catch(() => ({ radios: 0, contactEmails: 0, checkboxes: 0 }));
      const stepText = await page.evaluate(() => (document.querySelector("[role=main], main") || document.body).innerText.substring(0, 300)).catch(() => "");
      console.error(`[create] Wizard step ${step}: ${JSON.stringify(elems)}`);
      if (stepText.includes("ID de cliente") || stepText.includes("Client ID") || stepText.includes("se creó correctamente")) { wizardDone = true; break; }

      if (elems.radios > 0) {
        const ext = page.locator("mat-radio-button").filter({ hasText: /externo|external/i }).first();
        if (await ext.count().catch(() => 0) > 0) await ext.click({ force: true }).catch(() => {});
        else await page.evaluate(() => { const rs = Array.from(document.querySelectorAll("mat-radio-button")).filter(e => e.offsetWidth > 0); (rs[1] ?? rs[0])?.click(); }).catch(() => {});
        await page.waitForTimeout(400);
      } else if (elems.contactEmails > 0) {
        const inp = page.locator('input[placeholder*="correo" i], input[placeholder*="email" i], input[type="email"]:not([id="mat-input-0"])').first();
        if (await inp.isVisible({ timeout: 2000 }).catch(() => false)) { await inp.fill(SUPPORT_EMAIL); await inp.press("Enter").catch(() => {}); }
      } else if (elems.checkboxes > 0) {
        await page.evaluate(() => { const cb = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(e => e.offsetWidth > 0 && !e.checked); if (cb) cb.click(); }).catch(() => {});
      }

      const btn = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button")).filter(b => b.offsetWidth > 0 && !b.disabled);
        return btns.find(b => /^(siguiente|next|continuar|continue)$/i.test(b.textContent.trim()))?.textContent.trim()
          ?? btns.find(b => /^(crear|create|finalizar|finish)$/i.test(b.textContent.trim()))?.textContent.trim()
          ?? null;
      }).catch(() => null);
      if (!btn) { wizardDone = true; break; }
      console.error(`[create] Clicking: '${btn}'`);
      await page.evaluate(t => { Array.from(document.querySelectorAll("button")).find(b => b.offsetWidth > 0 && new RegExp(`^${t}$`, "i").test(b.textContent.trim()))?.click(); }, btn).catch(() => {});
      await page.waitForTimeout(2000);
      if (/^(crear|create|finalizar|finish)$/i.test(btn)) {
        const url0 = page.url();
        for (let t = 0; t < 12; t++) { await page.waitForTimeout(1000); if (page.url() !== url0) break; }
        console.error("[create] Waiting 12s for consent screen to propagate...");
        await page.waitForTimeout(12000);
        wizardDone = true;
      }
    }

    await page.goto(
      `https://console.cloud.google.com/auth/clients/create?project=${PROJECT_ID}`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    await page.waitForTimeout(5000);
  }

  // Wait for client creation form
  await page.waitForSelector("cfc-select, mat-select, input[formcontrolname=displayName]", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Select "Web application"
  if (await page.locator("cfc-select").first().isVisible({ timeout: 3000 }).catch(() => false)) {
    const cur = await page.evaluate(() => document.querySelector("cfc-select")?.textContent?.trim() ?? "").catch(() => "");
    if (!/web/i.test(cur)) {
      await page.locator("cfc-select").first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const web = Array.from(document.querySelectorAll("[role=option], mat-option")).find(o => /aplicaci.*web|web application/i.test(o.textContent));
        if (web) web.click();
      }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  // Fill client name
  await tryFill(page, [
    'input[formcontrolname="displayName"]', 'input[formcontrolname="name"]',
    'input[aria-label*="name" i]', 'input[aria-label*="nombre" i]',
    'input[placeholder*="name" i]', 'mat-form-field input[type="text"]',
  ], APP_NAME, "client name");

  // Add redirect URI (2nd "Agregar URI" button = redirect URIs section)
  const uriCount = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"))
      .filter(b => b.offsetWidth > 0 && /agregar uri|add uri/i.test(b.textContent.trim()));
    (btns[1] ?? btns[0])?.click();
    return btns.length;
  }).catch(() => 0);
  console.error(`[create] Add URI buttons: ${uriCount}`);
  await page.waitForTimeout(800);

  const uriInput = page.locator('input[formcontrolname="uri"], input[placeholder*="https://" i]').last();
  if (await uriInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await uriInput.fill(REDIRECT_URI);
  } else {
    await page.evaluate(uri => {
      const inp = Array.from(document.querySelectorAll("input")).find(el => el.placeholder.includes("https://") && el.offsetWidth > 0);
      if (inp) { inp.focus(); inp.value = uri; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); }
    }, REDIRECT_URI).catch(() => {});
  }
  await page.waitForTimeout(300);

  // Submit
  console.error("[create] Submitting...");
  await screenshot(page, "before-submit");
  await tryClick(page, [
    'button[type="submit"]:has-text("Crear")', 'button[type="submit"]:has-text("Create")',
    'button:has-text("CREAR")', 'button:has-text("Crear"):not(:has-text("credenciales"))',
  ], "Create button");
  await page.waitForTimeout(3000);
  await screenshot(page, "after-submit");

  // Grab Client ID from dialog before dismissing
  let clientId = "";
  const dialogHtml = await page.evaluate(() => document.body.innerHTML).catch(() => "");
  const idMatch = dialogHtml.match(/(\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com)/);
  if (idMatch) { clientId = idMatch[1]; console.error(`[create] Client ID from dialog: ${clientId.substring(0, 50)}`); }

  // Dismiss dialog
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b => /aceptar|accept|ok|cerrar|close/i.test(b.textContent.trim()));
    if (btn) btn.click();
  }).catch(() => {});
  await page.waitForTimeout(1500);

  // Get secret via "Add secret" (Google masks the original immediately)
  const creds = await addAndExtractSecret();
  if (clientId && !creds.clientId) creds.clientId = clientId;

  if (!creds.clientId)     throw new Error("Could not extract Client ID. Check gcp-oauth-clients-list.png");
  if (!creds.clientSecret) throw new Error("Could not extract secret. Check gcp-oauth-after-add-secret.png");

  console.log(JSON.stringify(creds));

} catch (err) {
  await screenshot(page, "error");
  console.error("ERROR:", err.message);
  process.exit(1);
} finally {
  await context.close().catch(() => {});
  if (IS_MAC) spawnSync("open", ["-a", "Google Chrome"], { encoding: "utf8" });
  else if (IS_WIN) spawnSync("start", ["chrome"], { shell: true });
}
