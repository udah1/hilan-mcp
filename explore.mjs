import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({ headless: true });

async function dumpForm(page, label) {
  const forms = await page.$$eval('form', (forms) =>
    forms.map((f) => ({
      id: f.id,
      action: f.action,
      method: f.method,
      inputs: Array.from(f.querySelectorAll('input,button,select')).map((el) => ({
        tag: el.tagName,
        id: el.id,
        name: el.name,
        type: el.type,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label'),
        text: el.textContent?.trim().slice(0, 60),
      })),
    }))
  );
  console.log(`\n=== FORMS on ${label} ===`);
  console.log(JSON.stringify(forms, null, 2));
  return forms;
}

const page = await browser.newPage();

console.log('--- GENERIC LOGIN PAGE: https://net.hilan.co.il/login ---');
await page.goto('https://net.hilan.co.il/login', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await dumpForm(page, 'generic login (org step)');
await page.screenshot({ path: 'shot-1-generic-login.png', fullPage: true });

console.log('\n--- Trying to submit org id 5227 (Technion, publicly known org number) ---');
await page.fill('#orgId', '5227');
// find submit-like button
const buttons = await page.$$eval('button', (bs) => bs.map((b) => ({ id: b.id, text: b.textContent?.trim(), type: b.type })));
console.log('Buttons found:', JSON.stringify(buttons, null, 2));

try {
  await page.click('button[type="submit"]');
} catch (e) {
  console.log('submit click failed:', e.message);
}
await page.waitForTimeout(2500);
console.log('URL after org submit:', page.url());
await dumpForm(page, 'after org submit (should be employee login step)');
await page.screenshot({ path: 'shot-2-after-org-submit.png', fullPage: true });

console.log('\n--- AMDOCS DIRECT SUBDOMAIN: https://amdocs.net.hilan.co.il/login ---');
const page2 = await browser.newPage();
await page2.goto('https://amdocs.net.hilan.co.il/login', { waitUntil: 'networkidle' });
await page2.waitForTimeout(1000);
await dumpForm(page2, 'amdocs subdomain login');
await page2.screenshot({ path: 'shot-3-amdocs-login.png', fullPage: true });

await browser.close();
console.log('\nDONE. Screenshots saved in current directory.');
