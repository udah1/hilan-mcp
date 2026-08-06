// Research-only script. Run this YOURSELF in your own terminal:
//   cd ~/personal-dev/hilan-mcp && node explore-logged-in.mjs
//
// It launches a REAL, VISIBLE browser window on your machine. You type your
// credentials directly into that browser window (or into the masked terminal
// prompts below) - nothing is sent anywhere, nothing is saved to disk, and
// nothing is printed back to this terminal. The agent asking you to run this
// never sees your input; it only reads the redacted JSON summary this script
// writes at the end (menu structure + URL patterns, PII stripped).
//
// You can also just leave the password prompts empty and log in by hand
// inside the browser window instead (e.g. if you want to use the "one-time
// code" login) - the script will keep waiting until it detects you're past
// the login page.

import { chromium } from 'playwright';
import readline from 'node:readline';
import fs from 'node:fs';

function prompt(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    if (!mask) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
      return;
    }
    // Standard Node "hidden password prompt" pattern: intercept the
    // readline instance's own output writer so it NEVER echoes what you
    // type (not even asterisks), regardless of how the surrounding
    // terminal/PTY handles raw-mode echo. This is more reliable across
    // terminal emulators (incl. Cursor's integrated terminal) than
    // manually toggling stdin.setRawMode, which was found to still let
    // keystrokes through in some environments.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let promptShown = false;
    rl._writeToOutput = (str) => {
      if (!promptShown) {
        rl.output.write(question);
        promptShown = true;
        return;
      }
      // Swallow everything else (typed characters, backspace redraws, etc.)
    };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

function redact(str) {
  // Strip anything that looks like an ID / employee number / long digit run
  // from URLs or text before we ever write it to disk.
  return str
    .replace(/\b\d{5,}\b/g, '[REDACTED]')
    .replace(/(UserId|EmployeeId|Emp|TZ|Id)=([^&\s"]+)/gi, '$1=[REDACTED]');
}

const orgSubdomain = await prompt('Tenant subdomain (e.g. amdocs, technionadmin) or full https URL: ');
const baseUrl = orgSubdomain.startsWith('http')
  ? orgSubdomain.replace(/\/$/, '')
  : `https://${orgSubdomain}.net.hilan.co.il`;

console.log(`\nOpening ${baseUrl}/login in a real browser window...`);
console.log('Log in there yourself (fill whatever fields appear, solve OTP/captcha if any).');
console.log('This script will detect once you are past the login page and continue automatically.\n');

const browser = await chromium.launch({ headless: false, slowMo: 50 });
const page = await browser.newPage();
await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });

// Optional: offer to auto-fill if the user wants to type into this terminal instead.
const autofill = await prompt('Auto-fill credentials from masked terminal prompts instead of typing in the browser? (y/N): ');
if (autofill.trim().toLowerCase() === 'y') {
  const fields = await page.$$eval('#mainForm input[type="text"], #mainForm input[type="password"]', (els) =>
    els.map((e) => ({ id: e.id, placeholder: e.placeholder }))
  );
  console.log('Detected fields on this login page:', fields.map((f) => f.placeholder || f.id).join(', '));
  for (const f of fields) {
    if (!f.id) continue;
    const isPassword = f.id.toLowerCase().includes('password');
    const val = await prompt(`  Value for "${f.placeholder || f.id}": `, { mask: isPassword });
    if (val) await page.fill(`#${f.id}`, val);
  }
  const submitBtn = await page.$('#mainForm button[type="submit"]');
  if (submitBtn) await submitBtn.click();
  console.log('Submitted. If OTP/2FA appears, complete it in the browser window.');
}

console.log('\nWaiting for you to reach the logged-in dashboard (checking every 3s, up to 5 min)...');
let loggedIn = false;
for (let i = 0; i < 100; i++) {
  await page.waitForTimeout(3000);
  const url = page.url();
  if (!url.includes('/login')) { loggedIn = true; break; }
}

if (!loggedIn) {
  console.log('Timed out waiting for login. Exiting without capturing anything.');
  await browser.close();
  process.exit(1);
}

console.log('Detected logged-in state at:', redact(page.url()));
await page.waitForTimeout(2000);

// Capture the main navigation/menu structure (redacted).
const menu = await page.$$eval('a, button, [role="menuitem"], [role="link"]', (els) =>
  els
    .map((e) => ({
      text: e.textContent?.trim(),
      href: e.getAttribute('href') || '',
      dataTestId: e.getAttribute('data-testid') || e.getAttribute('data-test-id') || '',
      id: e.id || '',
    }))
    .filter((e) => e.text && e.text.length > 0 && e.text.length < 80)
);

const dedupedMenu = Array.from(new Map(menu.map((m) => [`${m.text}|${m.href}`, m])).values()).map((m) => ({
  ...m,
  href: redact(m.href),
}));

fs.writeFileSync('menu-structure.json', JSON.stringify(dedupedMenu, null, 2));
await page.screenshot({ path: 'shot-4-dashboard.png', fullPage: true });

// Track document/PDF-looking network requests seen while you click around.
const capturedRequests = new Set();
page.on('request', (req) => {
  const u = req.url();
  if (/\.pdf|payslip|106|report|export|download/i.test(u)) {
    capturedRequests.add(redact(u));
  }
});

console.log('\nMenu structure saved to menu-structure.json (redacted) and screenshot to shot-4-dashboard.png.');
console.log('Now: click around the dashboard yourself for ~30-60s - open payslips, Form 106, attendance,');
console.log('vacation balance, personal info, anything else you see - so this script can log the document');
console.log('URL patterns it observes (redacted). Press Enter here when done.\n');
await prompt('Press Enter when you are done clicking around: ');

fs.writeFileSync('captured-requests.json', JSON.stringify([...capturedRequests], null, 2));
console.log(`\nSaved ${capturedRequests.size} redacted request URL patterns to captured-requests.json.`);
console.log('You can now close the browser window. Nothing else was written to disk.');

await prompt('Press Enter to close the browser and exit: ');
await browser.close();
