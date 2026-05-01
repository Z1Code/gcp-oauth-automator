#!/usr/bin/env node
/**
 * Playwright automation: creates a Google OAuth 2.0 Web Client ID
 * in Google Cloud Console and prints the credentials as JSON.
 *
 * Usage:
 *   node create-oauth-client.mjs <project-id> <app-name> <redirect-uri> <support-email>
 *
 * Output (stdout, JSON):
 *   { "clientId": "...", "clientSecret": "..." }
 *
 * First run: Chrome opens on your Mac — sign into Google Cloud Console once.
 * All subsequent runs: fully automatic (session saved to dedicated profile).
 */

import { chromium } from "playwright";
import os from "os";
import { spawnSync } from "child_process";

const [, , PROJECT_ID, APP_NAME, REDIRECT_URI, SUPPORT_EMAIL] = process.argv;

if (!PROJECT_ID || !APP_NAME || !REDIRECT_URI || !SUPPORT_EMAIL) {
  console.error(
    "Usage: node create-oauth-client.mjs <project-id> <app-name> <redirect-uri> <support-email>"
  );
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, description) {
  for (const sel of selectors) {
    try {
      await page.locator(sel).first().click({ timeout: 5000 });
      return true;
    } catch {}
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
  // Dump all inputs for diagnostics
  const allInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, textarea')).map(el => ({
      tag: el.tagName,
      type: el.type,
      id: el.id,
      name: el.name,
      placeholder: el.placeholder,
      ariaLabel: el.getAttribute('aria-label'),
      formcontrolname: el.getAttribute('formcontrolname'),
      class: el.className.substring(0, 80),
      value: el.value.substring(0, 40),
    }));
  }).catch(() => []);
  console.error(`[DIAG] All inputs on page (${allInputs.length}):`);
  for (const inp of allInputs) console.error(`  ${JSON.stringify(inp)}`);
  throw new Error(`Could not find input: ${description}`);
}

async function screenshot(page, name) {
  await page.screenshot({ path: `/tmp/gcp-oauth-${name}.png` }).catch(() => {});
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const DEBUG_PORT = 9222;

// Dedicated automation Chrome profile — NOT the user's real Chrome profile.
// On first run, Chrome opens and the user signs in once. The session is saved
// here permanently. All future runs are fully automatic.
const AUTOMATION_PROFILE = `${os.homedir()}/.claude-skills/google-oauth-setup/chrome-profile`;

// 1. Kill existing Chrome completely, wait for it to die
const chromeRunning = spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf8" }).stdout.trim();
if (chromeRunning) {
  console.error("[0/6] Closing Chrome to relaunch with debug port...");
  spawnSync("osascript", ["-e", 'tell application "Google Chrome" to quit saving yes'], { encoding: "utf8" });
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const still = spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf8" }).stdout.trim();
    if (!still) { console.error(`[0/6] Chrome exited after ${i + 1}s`); break; }
    if (i === 9) {
      spawnSync("pkill", ["-9", "-x", "Google Chrome"], { encoding: "utf8" });
    }
  }
  await new Promise(r => setTimeout(r, 1000));
}

// 2. Launch Chrome with the dedicated automation profile and debug port.
//    Uses macOS 'open' which routes through the GUI session — works from SSH.
console.error(`[0/6] Launching Chrome with automation profile + --remote-debugging-port=${DEBUG_PORT}...`);
spawnSync("open", [
  "-a", "Google Chrome",
  "--args",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${AUTOMATION_PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { encoding: "utf8" });

// 3. Poll until debug port is ready (up to 25s)
console.error("[0/6] Waiting for Chrome debug port...");
let portReady = false;
for (let i = 0; i < 25; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const check = spawnSync("curl", ["-s", "--max-time", "1", `http://127.0.0.1:${DEBUG_PORT}/json/version`], { encoding: "utf8" });
  if (check.stdout && check.stdout.includes("webSocketDebuggerUrl")) {
    portReady = true;
    console.error(`[0/6] Debug port ready after ${i + 1}s`);
    break;
  }
}
if (!portReady) throw new Error(`Chrome debug port ${DEBUG_PORT} not ready after 25s`);

// 4. Connect Playwright to the running Chrome via CDP
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const existingContexts = browser.contexts();
const context = existingContexts.length > 0 ? existingContexts[0] : await browser.newContext();
const page = await context.newPage();

try {
  // ── 1. Navigate to credentials page ────────────────────────────────────────
  console.error(`[1/6] Opening credentials page for project: ${PROJECT_ID}`);
  await page.goto(
    `https://console.cloud.google.com/apis/credentials?project=${PROJECT_ID}`,
    { waitUntil: "domcontentloaded", timeout: 60000 }
  );
  await page.waitForTimeout(3000);
  await screenshot(page, "step1-credentials");

  // ── First-run: wait for the user to sign in if needed ────────────────────
  if (page.url().includes("accounts.google.com")) {
    console.error("");
    console.error("⚠️  FIRST RUN — One-time sign-in required:");
    console.error("   → Look at the Chrome window on your Mac.");
    console.error(`   → Sign in with your Google account (${SUPPORT_EMAIL})`);
    console.error("   → Navigate to console.cloud.google.com if needed");
    console.error("   → Waiting up to 3 minutes...");
    console.error("");
    await page.waitForURL(url => !url.toString().includes("accounts.google.com"), { timeout: 180000 });
    console.error("[1/6] Signed in. Re-navigating to credentials page...");
    await page.goto(
      `https://console.cloud.google.com/apis/credentials?project=${PROJECT_ID}`,
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );
    await page.waitForTimeout(3000);
    await screenshot(page, "step1-after-login");
  }

  // Handle "Accept terms" dialog if present
  try {
    const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("I agree")');
    if (await acceptBtn.first().isVisible({ timeout: 3000 })) {
      await acceptBtn.first().click();
      await page.waitForTimeout(2000);
    }
  } catch {}

  // ── 2. Skip (consent screen setup handled in step 3 flow) ──────────────────
  console.error("[2/6] Skipped (consent screen handled in client creation flow).");

  // ── 3. Navigate to client creation, configure consent screen if needed ───────
  console.error("[3/6] Creating OAuth Web Client ID...");
  await page.goto(
    `https://console.cloud.google.com/auth/clients/create?project=${PROJECT_ID}`,
    { waitUntil: "domcontentloaded", timeout: 30000 }
  );
  await page.waitForTimeout(3000);
  await screenshot(page, "step3-create-client");

  // Handle "configure consent screen" warning if present.
  // IMPORTANT: wait 12s for Angular to fully render the page before checking.
  // The warning button may appear transiently during the loading phase;
  // checking too early causes false positives even when consent IS configured.
  await page.waitForTimeout(12000);
  await screenshot(page, "step3-clients-create-loaded");
  const consentWarningVisible = await page
    .locator('button:has-text("Configurar pantalla de consentimiento"), button:has-text("Configure consent screen"), a:has-text("Configurar pantalla de consentimiento")')
    .first()
    .isVisible()
    .catch(() => false);
  console.error(`[3/6] Consent warning visible: ${consentWarningVisible}. URL: ${page.url()}`);
  if (consentWarningVisible) {
    console.error("[3/6] Consent screen not configured — setting it up now...");
    await page.locator('button:has-text("Configurar pantalla de consentimiento"), button:has-text("Configure consent screen"), a:has-text("Configurar pantalla de consentimiento")').first().click();
    await page.waitForTimeout(3000);
    await screenshot(page, "step3-branding-page");

    // Wait for branding page to load
    await page.waitForTimeout(4000);
    await screenshot(page, "step3-branding-loaded");
    console.error(`[3/6] Branding page URL: ${page.url()}`);

    // Dump all buttons on branding page for diagnostics
    const allButtons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, [role="button"], a[href]')).slice(0, 30).map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        text: el.textContent.trim().substring(0, 60),
        ariaLabel: el.getAttribute('aria-label'),
        class: el.className.substring(0, 60),
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
      }));
    }).catch(() => []);
    console.error(`[DIAG] Buttons on branding page (${allButtons.length}):`);
    for (const btn of allButtons) console.error(`  ${JSON.stringify(btn)}`);

    // Try to click "Comenzar" / "Get started" if present (required before form appears)
    // Try multiple strategies
    let comenzarClicked = false;
    // Strategy 1: getByRole
    try {
      await page.getByRole('button', { name: /comenzar|get started|empezar/i }).first().click({ timeout: 5000 });
      console.error("[3/6] Clicked 'Comenzar' (getByRole).");
      comenzarClicked = true;
    } catch {}
    // Strategy 2: locator has-text
    if (!comenzarClicked) {
      try {
        await page.locator('button:has-text("Comenzar"), button:has-text("Get started"), button:has-text("Empezar")').first().click({ timeout: 5000 });
        console.error("[3/6] Clicked 'Comenzar' (locator).");
        comenzarClicked = true;
      } catch {}
    }
    // Strategy 3: evaluate click on ANY element (including custom web components) with matching text
    if (!comenzarClicked) {
      try {
        const clicked = await page.evaluate(() => {
          // Walk all elements including shadow DOM
          function findAndClick(root) {
            const all = root.querySelectorAll('*');
            for (const el of all) {
              const txt = (el.textContent || '').trim().toLowerCase();
              const directTxt = Array.from(el.childNodes)
                .filter(n => n.nodeType === 3)
                .map(n => n.textContent.trim())
                .join(' ').toLowerCase();
              if ((directTxt.includes('comenzar') || directTxt.includes('get started') || directTxt.includes('empezar'))
                  && el.offsetWidth > 0 && el.offsetHeight > 0) {
                el.click();
                return el.tagName + ':' + (el.textContent || '').trim().substring(0, 40);
              }
              if (el.shadowRoot) {
                const res = findAndClick(el.shadowRoot);
                if (res) return res;
              }
            }
            return null;
          }
          return findAndClick(document);
        });
        if (clicked) {
          console.error(`[3/6] Clicked '${clicked}' via evaluate (all elements).`);
          comenzarClicked = true;
        }
      } catch {}
    }
    // Strategy 4: Playwright getByText
    if (!comenzarClicked) {
      try {
        await page.getByText('Comenzar', { exact: true }).first().click({ timeout: 4000 });
        console.error("[3/6] Clicked 'Comenzar' (getByText).");
        comenzarClicked = true;
      } catch {}
    }
    if (!comenzarClicked) {
      console.error("[3/6] 'Comenzar' button not found — may already be on form or different UI state.");
    }
    await page.waitForTimeout(4000);
    await screenshot(page, "step3-branding-form");

    // Dump inputs including Shadow DOM
    const brandingInputs = await page.evaluate(() => {
      function getAllInputs(root, depth = 0) {
        const results = [];
        const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of elements) {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            results.push({
              tag: el.tagName, type: el.type, id: el.id, placeholder: el.placeholder,
              ariaLabel: el.getAttribute('aria-label'), formcontrolname: el.getAttribute('formcontrolname'),
              visible: el.offsetWidth > 0 && el.offsetHeight > 0, depth,
            });
          }
          if (el.shadowRoot) {
            results.push(...getAllInputs(el.shadowRoot, depth + 1));
          }
        }
        return results;
      }
      return getAllInputs(document);
    }).catch(() => []);
    console.error(`[DIAG] Inputs on branding page (incl shadow, ${brandingInputs.length}):`);
    for (const inp of brandingInputs) console.error(`  ${JSON.stringify(inp)}`);

    // Also dump main content text to understand page state
    const mainText = await page.evaluate(() => {
      const main = document.querySelector('[role="main"], main, .cfc-page-content, #content');
      return main ? main.innerText.substring(0, 800) : document.body.innerText.substring(0, 800);
    }).catch(() => '');
    console.error(`[DIAG] Page main text: ${mainText.substring(0, 400)}`);

    // Step 1 of wizard: Fill "Nombre de la aplicación" (displayName) and support email
    try {
      const nameInput = page.locator('input[formcontrolname="displayName"]').first();
      await nameInput.waitFor({ state: 'visible', timeout: 8000 });
      const val = await nameInput.inputValue().catch(() => "");
      // Always overwrite if value doesn't match (corrupted from previous run)
      if (val.trim() !== APP_NAME.trim()) await nameInput.fill(APP_NAME);
      console.error("[3/6] App name filled.");
    } catch { console.error("[3/6] Could not fill app name (displayName)"); }

    // Fill support email — it's a mat-select dropdown in the active step 1.
    // IMPORTANT: use mat-select:visible to skip hidden mat-selects in collapsed accordion steps.
    // Never use force:true on hidden inputs — it appends to the previously-focused field instead.
    try {
      let emailFilled = false;

      // Dump ALL potentially interactive elements on wizard page (role=combobox/listbox, custom GCP components)
      const emailFieldDump = await page.evaluate(() => {
        // Find all elements that could be a dropdown/combobox
        const candidates = document.querySelectorAll(
          '[role="combobox"], [role="listbox"], mat-select, ' +
          '[class*="combobox"], [class*="select"]:not(select):not(input):not(button), ' +
          '[aria-haspopup], [aria-expanded]'
        );
        return JSON.stringify(Array.from(candidates).map(el => ({
          t: el.tagName, c: el.className.substring(0, 70),
          r: el.getAttribute('role'), w: el.offsetWidth, h: el.offsetHeight,
          aria: el.getAttribute('aria-label'), id: el.id,
          expanded: el.getAttribute('aria-expanded'), popup: el.getAttribute('aria-haspopup'),
        })).filter(e => e.w > 0 || e.h > 0 || e.r === 'combobox').slice(0, 30));
      }).catch(() => 'error');
      console.error(`[3/6] Dropdown candidates: ${emailFieldDump}`);

      // Email dropdown is a GCP-custom `cfc-select` component (NOT mat-select).
      // ID: _0rif_cfc-select-0, role=combobox, aria-haspopup=listbox — it IS visible (452x24).
      const clickResult = await page.evaluate(() => {
        // Try cfc-select by tag first, then by role+popup combo, then .cfc-select-trigger
        const el = document.querySelector('cfc-select') ||
          document.querySelector('[role="combobox"][aria-haspopup="listbox"]') ||
          document.querySelector('.cfc-select-trigger');
        if (!el) return 'not-found';
        el.scrollIntoView({ behavior: 'instant' });
        el.click();
        return el.tagName + ':' + (el.id || el.className.substring(0, 40));
      }).catch(e => 'error:' + e.message);
      console.error(`[3/6] cfc-select click: ${clickResult}`);
      await page.waitForTimeout(800);
      // Options appear as cfc-option or [role="option"] in the overlay
      const opts1 = await page.locator('cfc-option, [role="option"]').allTextContents().catch(() => []);
      console.error(`[3/6] cfc-select options: ${opts1.join(', ')}`);
      if (opts1.length > 0) {
        const target = page.locator('cfc-option, [role="option"]').filter({ hasText: SUPPORT_EMAIL });
        if (await target.count().catch(() => 0) > 0) {
          await target.first().click();
        } else {
          await page.locator('cfc-option, [role="option"]').first().click();
          console.error(`[3/6] Selected first option: ${opts1[0]}`);
        }
        emailFilled = true;
        console.error('[3/6] Support email selected from cfc-select.');
      }

      // Fallback: try clicking the .cfc-select-trigger div directly
      if (!emailFilled) {
        const trig = await page.evaluate(() => {
          const t = document.querySelector('.cfc-select-trigger');
          if (t) { t.scrollIntoView({ behavior: 'instant' }); t.click(); return true; }
          return false;
        });
        if (trig) {
          await page.waitForTimeout(700);
          const opts2 = await page.locator('cfc-option, [role="option"]').allTextContents().catch(() => []);
          console.error(`[3/6] Trigger fallback options: ${opts2.join(', ')}`);
          if (opts2.length > 0) {
            await page.locator('cfc-option, [role="option"]').first().click();
            emailFilled = true;
            console.error(`[3/6] Email selected via trigger fallback: ${opts2[0]}`);
          }
        }
      }

      if (!emailFilled) {
        console.error('[3/6] WARNING: Could not select email from dropdown — will try to proceed.');
      }
    } catch(e) { console.error(`[3/6] Support email error: ${e.message}`); }

    await screenshot(page, "step3-branding-filled");
    await page.waitForTimeout(1000);

    await screenshot(page, "step3-branding-page2");

    // Run wizard steps with content logging
    let wizardDone = false;
    for (let step = 1; step <= 8 && !wizardDone; step++) {
      await page.waitForTimeout(1500);
      const stepText = await page.evaluate(() => {
        const main = document.querySelector('[role="main"], main, .cfc-page-content, #content, [class*="content"]');
        return (main || document.body).innerText.substring(0, 500);
      }).catch(() => '');
      const stepUrl = page.url();
      const stepBtns = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() && b.offsetWidth > 0).map(b => b.textContent.trim())).catch(() => []);
      console.error(`[3/6] Wizard step ${step}: URL=${stepUrl.split('?')[0]}, buttons=[${stepBtns.join(', ')}], text=${stepText.substring(0, 150)}`);
      await screenshot(page, `step3-wizard-${step}`);

      // Detect current wizard step by content
      if (stepText.includes('ID de cliente') || stepText.includes('Client ID') || stepText.includes('GOCSPX') || stepText.includes('client_secret')) {
        console.error("[3/6] Wizard complete — credentials visible.");
        wizardDone = true;
        break;
      }
      if (stepText.includes('¡Se completó la configuración') || stepText.includes('Setup complete') || stepText.includes('se creó correctamente')) {
        console.error("[3/6] Wizard complete — setup success message.");
        wizardDone = true;
        break;
      }

      // Detect active wizard step by VISIBLE form elements (not text — text detection is unreliable
      // because the first 300 chars are always navbar/accessibility text, not accordion content).
      const stepElems = await page.evaluate(() => {
        const vis = el => el.offsetWidth > 0 && el.offsetHeight > 0;
        // Radio buttons for audience step (collapsed steps have h=0)
        const radios = Array.from(document.querySelectorAll('mat-radio-button')).filter(vis);
        // Email inputs for contact step — GCP uses input[type="text"] with email placeholder!
        // Exclude: search bar (id=mat-input-0), app name inputs, search-labelled inputs
        const emailInputs = Array.from(document.querySelectorAll(
          'input[type="email"], input[type="text"], input:not([type])'
        )).filter(el => {
          if (!vis(el)) return false;
          if (el.id === 'mat-input-0') return false; // top search bar
          const lbl = (el.getAttribute('aria-label') || el.placeholder || el.getAttribute('formcontrolname') || '').toLowerCase();
          // Exclude search bar and app name inputs
          if (/buscar|search|nombre de la app|displayname|appname|nombre de la aplicaci/i.test(lbl)) return false;
          // Include if email-related label/placeholder
          if (/correo|email|contact|developer|desarrollad/i.test(lbl)) return true;
          // Include any other visible non-identified input (likely a contact field)
          return true;
        });
        // Also catch by formcontrolname
        const contactInputs = Array.from(document.querySelectorAll(
          'input[formcontrolname*="email" i], input[formcontrolname*="contact" i], input[formcontrolname*="developer" i]'
        )).filter(vis);
        // Checkboxes for finalize step
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(vis);
        // App name input for step 1
        const appNameInputs = Array.from(document.querySelectorAll(
          'input[formcontrolname="displayName"], input[aria-label*="nombre" i], input[aria-label*="name" i]'
        )).filter(vis);
        return {
          radios: radios.length,
          radioTexts: radios.map(r => r.textContent?.trim().substring(0, 60) || ''),
          contactEmails: emailInputs.length + contactInputs.length,
          checkboxes: checkboxes.length,
          hasAppName: appNameInputs.length > 0,
        };
      }).catch(() => ({ radios: 0, contactEmails: 0, checkboxes: 0, hasAppName: false }));

      console.error(`[3/6] Step ${step} elements: radios=${stepElems.radios}[${stepElems.radioTexts?.join('|')}] emails=${stepElems.contactEmails} checkboxes=${stepElems.checkboxes} appName=${stepElems.hasAppName}`);

      if (stepElems.radios > 0) {
        // Audience step: MUST select a radio before Siguiente will advance
        // Try mat-radio-button with "externo" or "external" text
        const extBtn = page.locator('mat-radio-button').filter({ hasText: /externo|external/i }).first();
        if (await extBtn.count().catch(() => 0) > 0) {
          await extBtn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(400);
          console.error("[3/6] Step 2: Selected 'Usuarios externos'");
        } else {
          // Fallback: second radio = External (first = Internal in GCP)
          await page.evaluate(() => {
            const radios = Array.from(document.querySelectorAll('mat-radio-button'))
              .filter(el => el.offsetWidth > 0);
            const target = radios.length > 1 ? radios[1] : radios[0];
            if (target) target.click();
          }).catch(() => {});
          await page.waitForTimeout(400);
          console.error("[3/6] Step 2: Selected audience radio (fallback)");
        }
      } else if (stepElems.contactEmails > 0) {
        // Contact info step: fill developer contact email
        // GCP uses input[type="text"] with placeholder "Direcciones de correo electrónico *"
        const emailInput = page.locator(
          'input[placeholder*="correo" i], input[placeholder*="email" i], input[aria-label*="correo" i], input[formcontrolname*="email" i], input[type="email"]:not([id="mat-input-0"])'
        ).first();
        let filled = await emailInput.isVisible({ timeout: 2000 }).catch(() => false);
        if (filled) {
          await emailInput.fill(SUPPORT_EMAIL);
          // Press Enter or Tab to confirm (some inputs need this)
          await emailInput.press('Enter').catch(() => {});
          await page.waitForTimeout(300);
          console.error(`[3/6] Step 3: Filled contact email: ${SUPPORT_EMAIL}`);
        } else {
          // Fallback: try any visible text input that's not the search bar
          filled = await page.evaluate((email) => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
              .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && el.id !== 'mat-input-0');
            if (inputs.length > 0) {
              inputs[0].focus();
              inputs[0].value = email;
              inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
              inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          }, SUPPORT_EMAIL).catch(() => false);
          if (filled) console.error(`[3/6] Step 3: Filled contact email via fallback`);
        }
      } else if (stepElems.checkboxes > 0) {
        // Finalize step: check agreement checkbox
        await page.evaluate(() => {
          const cb = Array.from(document.querySelectorAll('input[type="checkbox"]'))
            .find(el => el.offsetWidth > 0 && !el.checked);
          if (cb) cb.click();
        }).catch(() => {});
        console.error("[3/6] Step 4: Checked agreement");
      } else {
        console.error(`[3/6] Step ${step}: No specific form elements detected — advancing`);
      }

      // Click the primary action button — prefer Siguiente to advance steps one at a time.
      // Only click Crear when no Siguiente is available (all steps complete / final step).
      const primaryBtn = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth > 0 && !b.disabled);
        // Prefer Siguiente/Next to advance one step at a time
        const nexts = btns.filter(b => /^(siguiente|next|continuar|continue)$/i.test(b.textContent.trim()));
        if (nexts.length > 0) return nexts[0].textContent.trim();
        // Only click Crear when all steps complete (no Siguiente remains)
        const creators = btns.filter(b => /^(crear|create|finalizar|finish)$/i.test(b.textContent.trim()));
        if (creators.length > 0) return creators[0].textContent.trim();
        return null;
      }).catch(() => null);

      if (!primaryBtn) {
        console.error("[3/6] No primary button found — wizard may be done.");
        wizardDone = true;
        break;
      }

      console.error(`[3/6] Clicking primary button: '${primaryBtn}'`);
      await page.evaluate((btnText) => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth > 0);
        const btn = btns.find(b => new RegExp(`^${btnText}$`, 'i').test(b.textContent.trim()));
        if (btn) btn.click();
      }, primaryBtn).catch(() => {});
      await page.waitForTimeout(2000);

      if (primaryBtn.match(/^(crear|create|finalizar|finish)$/i)) {
        console.error("[3/6] Clicked final wizard button — waiting for URL to change...");
        // Wait up to 12s for the URL to change (consent screen created)
        const startUrl = page.url();
        for (let t = 0; t < 12; t++) {
          await page.waitForTimeout(1000);
          if (page.url() !== startUrl) { console.error(`[3/6] URL changed after ${t+1}s`); break; }
        }
        await screenshot(page, `step3-after-crear`);
        // CRITICAL: wait 12s after creation before navigating to clients/create.
        // The GCP backend needs time to propagate the consent screen status.
        // Without this delay, clients/create shows a false "configure first" warning.
        console.error("[3/6] Waiting 12s for consent screen status to propagate...");
        await page.waitForTimeout(12000);
        wizardDone = true;
      }
    }

    console.error(`[3/6] Wizard done. Current URL: ${page.url()}`);

    // After consent screen wizard completes, navigate to clients/create for the OAuth client
    const postWizardUrl = page.url();
    console.error(`[3/6] Post-wizard URL: ${postWizardUrl}`);
    await screenshot(page, "step3-back-to-create");

    // If still on overview/create, wizard may not have completed — try navigating directly
    // If URL changed, wizard succeeded — navigate to clients/create
    if (!postWizardUrl.includes('clients/create')) {
      console.error("[3/6] Navigating to OAuth clients/create page...");
      await page.goto(
        `https://console.cloud.google.com/auth/clients/create?project=${PROJECT_ID}`,
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );
      await page.waitForTimeout(5000);
    }
    await screenshot(page, "step3-client-create-page");
    console.error(`[3/6] Client creation URL: ${page.url()}`);
  }

  // Wait for the client creation form to load
  // GCP's new Google Auth Platform uses cfc-select (not mat-select) for app type
  const formReady = await page.waitForSelector(
    'cfc-select[formcontrolname="typeControl"], cfc-select, input[value="WEB"], mat-select, input[formcontrolname="displayName"], input[formcontrolname="name"]',
    { timeout: 30000 }
  ).then(() => true).catch(() => false);
  console.error(`[4/6] Form ready: ${formReady}. URL: ${page.url()}`);
  await page.waitForTimeout(2000);
  await screenshot(page, "step4-oauth-form");

  // If form still not ready, navigate to clients/create explicitly
  if (!formReady) {
    // Check if consent screen is blocking (look for the "configure consent screen" warning)
    const consentWarning = await page.locator(
      'button:has-text("Configurar pantalla de consentimiento"), button:has-text("Configure consent screen"), a:has-text("Configurar pantalla de consentimiento")'
    ).isVisible({ timeout: 3000 }).catch(() => false);

    if (consentWarning) {
      console.error("[4/6] Consent screen still not configured — clicking 'Configurar pantalla de consentimiento'...");
      await page.locator(
        'button:has-text("Configurar pantalla de consentimiento"), button:has-text("Configure consent screen"), a:has-text("Configurar pantalla de consentimiento")'
      ).first().click().catch(() => {});
      await page.waitForTimeout(3000);
      await page.waitForSelector('cfc-step-header, mat-step-header, input[formcontrolname="displayName"]', { timeout: 20000 }).catch(() => {});
      await screenshot(page, "step4-consent-wizard-reopen");
      throw new Error("Consent screen wizard incomplete. Check /tmp/gcp-oauth-step4-consent-wizard-reopen.png on Mac and run script again after completing wizard manually.");
    }

    console.error("[4/6] Form not ready — navigating to clients/create...");
    await page.goto(
      `https://console.cloud.google.com/auth/clients/create?project=${PROJECT_ID}`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    ).catch(() => {});
    // Poll for cfc-select (new GCP UI) or other form indicators — up to 30s
    for (let t = 0; t < 30; t++) {
      await page.waitForTimeout(1000);
      const hasForm = await page.evaluate(() => {
        return document.querySelectorAll('cfc-select, input[formcontrolname], mat-radio-button, mat-select').length > 0;
      }).catch(() => false);
      if (hasForm) { console.error(`[4/6] Form appeared after ${t+1}s`); break; }
      if (t === 29) console.error("[4/6] Form did not appear after 30s — proceeding anyway");
    }
    await screenshot(page, "step4-clients-create");
  }

  // ── 5. Fill in the form ─────────────────────────────────────────────────────
  console.error("[4/6] Filling credentials form...");

  // Diagnostic: dump page text and inputs
  const step4Text = await page.evaluate(() => document.body.innerText.substring(0, 600)).catch(() => '');
  console.error(`[DIAG] Step4 page text: ${step4Text}`);
  const step4Inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, textarea')).map(el => ({
      id: el.id, type: el.type, formcontrolname: el.getAttribute('formcontrolname'),
      ariaLabel: el.getAttribute('aria-label'), placeholder: el.placeholder,
      visible: el.offsetWidth > 0 && el.offsetHeight > 0,
    }));
  }).catch(() => []);
  console.error(`[DIAG] Step4 inputs (${step4Inputs.length}): ${JSON.stringify(step4Inputs.slice(0, 10))}`);
  const step4Buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim()).map(b => ({
      text: b.textContent.trim().substring(0, 50), visible: b.offsetWidth > 0
    }));
  }).catch(() => []);
  console.error(`[DIAG] Step4 buttons: ${JSON.stringify(step4Buttons)}`);

  // Application type → Web application
  // GCP uses cfc-select (custom component), not mat-select. Use JS click to avoid overlay interception.
  await screenshot(page, "step4-form");
  const hasCfcSelect = await page.locator('cfc-select').first().isVisible({ timeout: 3000 }).catch(() => false);
  if (hasCfcSelect) {
    const currentType = await page.evaluate(() => {
      const s = document.querySelector('cfc-select');
      return s ? s.textContent.trim() : '';
    }).catch(() => '');
    if (!/web/i.test(currentType)) {
      console.error(`[4/6] cfc-select current: "${currentType}" — opening to select Web application`);
      await page.locator('cfc-select').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      // Use JS click to avoid mat-option overlay intercepting Playwright native click
      const optClicked = await page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll('[role=option], mat-option'));
        const web = opts.find(o => /aplicaci.*web|web application/i.test(o.textContent));
        if (web) { web.click(); return web.textContent.trim(); }
        return null;
      }).catch(() => null);
      console.error(`[4/6] Selected app type: ${optClicked}`);
      await page.waitForTimeout(1500); // Wait for form fields to expand after selection
    } else {
      console.error(`[4/6] App type already "Web application"`);
    }
  } else {
    // Fallback for older GCP UI (mat-select / input[value="WEB"])
    try {
      await page.locator('input[value="WEB"]').first().click({ timeout: 5000 });
    } catch {
      try {
        const typeSelect = page.locator('mat-select[formcontrolname="applicationType"]').first();
        await typeSelect.click({ timeout: 5000 });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
          const opts = Array.from(document.querySelectorAll('mat-option'));
          const web = opts.find(o => /web/i.test(o.textContent));
          if (web) web.click();
        });
      } catch {
        console.error("[4/6] Could not set app type — may already be Web application");
      }
    }
  }
  await page.waitForTimeout(500);

  // Name — input[formcontrolname="displayName"] is what GCP's new UI uses
  await tryFill(page, [
    'input[formcontrolname="displayName"]',
    'input[formcontrolname="name"]',
    'input[formcontrolname="clientName"]',
    'input[aria-label="Name"]',
    'input[aria-label="Nombre"]',
    'input[aria-label*="name" i]',
    'input[aria-label*="nombre" i]',
    '#displayName',
    '#name',
    'input[placeholder*="name" i]',
    'input[placeholder*="nombre" i]',
    'mat-form-field input[type="text"]',
  ], APP_NAME, "client name");

  // Add redirect URI — the form has two "Agregar URI" buttons:
  // 1st = JavaScript origins, 2nd = Redirect URIs. Click the 2nd.
  const addUriClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
      .filter(b => b.offsetWidth > 0 && b.offsetHeight > 0 && /agregar uri|add uri/i.test(b.textContent.trim()));
    const target = btns.length >= 2 ? btns[1] : btns[0];
    if (target) { target.click(); return btns.length; }
    return 0;
  }).catch(() => 0);
  console.error(`[4/6] Clicked Agregar URI (found ${addUriClicked} buttons)`);
  await page.waitForTimeout(800);

  // Fill redirect URI — input[formcontrolname="uri"] appears after clicking Agregar URI
  const uriInput = page.locator('input[formcontrolname="uri"], input[placeholder*="https://" i]').last();
  const uriFilled = await uriInput.isVisible({ timeout: 3000 }).catch(() => false);
  if (uriFilled) {
    await uriInput.fill(REDIRECT_URI);
  } else {
    await page.evaluate((uri) => {
      const inp = Array.from(document.querySelectorAll('input')).find(el => el.placeholder.includes('https://') && el.offsetWidth > 0);
      if (inp) {
        inp.focus(); inp.value = uri;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, REDIRECT_URI).catch(() => {});
    console.error("[4/6] Filled redirect URI via evaluate");
  }
  await page.waitForTimeout(300);

  // ── 6. Submit ──────────────────────────────────────────────────────────────
  console.error("[5/6] Submitting...");
  await screenshot(page, "step5-before-submit");
  await tryClick(page, [
    'button[type="submit"]:has-text("CREATE")',
    'button[type="submit"]:has-text("Create")',
    'button[type="submit"]:has-text("CREAR")',
    'button[type="submit"]:has-text("Crear")',
    'button:has-text("CREATE"):not(:has-text("CREDENTIALS")):not(:has-text("Consent"))',
    'button:has-text("CREAR"):not(:has-text("credenciales"))',
  ], "Create button");
  await page.waitForTimeout(3000);
  await screenshot(page, "step6-after-submit");

  // ── 7. Extract credentials from the confirmation dialog / client detail page ─
  console.error("[6/6] Extracting credentials...");
  // New GCP UI: after Crear, a dialog appears with Client ID. Secret requires info button click.
  await page.waitForTimeout(3000);
  await screenshot(page, "step7-after-submit");

  let clientId = "";
  let clientSecret = "";

  // Step A: Extract Client ID from the post-creation dialog (regex scan)
  const dialogText = await page.evaluate(() => document.body.innerHTML).catch(() => "");
  const idMatch = dialogText.match(/(\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com)/);
  if (idMatch) {
    clientId = idMatch[1];
    console.error(`[6/6] Got Client ID from dialog: ${clientId.substring(0, 30)}...`);
  }

  // Step B: Dismiss the dialog (click Aceptar/Accept/OK)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find(b => /aceptar|accept|ok|cerrar|close/i.test(b.textContent.trim()));
    if (btn) btn.click();
  }).catch(() => {});
  await page.waitForTimeout(1500);
  console.error(`[6/6] Post-dialog URL: ${page.url()}`);

  // Step C: Navigate to client detail page to get the secret
  // The detail URL uses the client ID
  if (clientId) {
    const detailUrl = `https://console.cloud.google.com/auth/clients/${clientId}?project=${PROJECT_ID}`;
    console.error(`[6/6] Navigating to client detail: ${detailUrl.substring(0, 80)}`);
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await screenshot(page, "step7-client-detail");
  } else {
    // Fallback: click the client link from the list
    await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll("a")).find(a => /caiena|oauth/i.test(a.textContent));
      if (link) link.click();
    }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  // Step D: Click "Información y resumen" info button to reveal Client Secret in DOM
  const infoClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const info = btns.find(b => b.getAttribute("aria-label") && /informaci|info|resumen|summary/i.test(b.getAttribute("aria-label")));
    if (info) { info.click(); return info.getAttribute("aria-label"); }
    return null;
  }).catch(() => null);
  console.error(`[6/6] Clicked info button: ${infoClicked}`);
  await page.waitForTimeout(1500);
  await screenshot(page, "step7-after-info");

  // Step E: Extract both credentials via regex from DOM
  const finalHtml = await page.evaluate(() => document.body.innerHTML).catch(() => "");
  if (!clientId || !clientId.includes("googleusercontent")) {
    const m = finalHtml.match(/(\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    if (m) clientId = m[1];
  }
  const secMatch = finalHtml.match(/(GOCSPX-[A-Za-z0-9_-]{20,})/);
  if (secMatch) clientSecret = secMatch[1];

  if (!clientId) {
    throw new Error("Could not extract Client ID. Check /tmp/gcp-oauth-step7-credentials-dialog.png");
  }

  console.log(JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }));

} catch (err) {
  await screenshot(page, "error");
  console.error("ERROR:", err.message);
  process.exit(1);
} finally {
  await context.close().catch(() => {});
  // Reopen Chrome with the real user profile (not the automation profile)
  console.error("Reopening Chrome...");
  spawnSync("open", ["-a", "Google Chrome"], { encoding: "utf8" });
}
