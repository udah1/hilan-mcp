// Research-only script, run by YOU in your own terminal:
//   cd ~/personal-dev/hilan-mcp && node probe-api.mjs
//
// Logs in the same way as explore-logged-in.mjs (hidden-prompt fixed this
// time), then opens the payslip and Form 106 screens itself and captures
// the *shape* of the internal JSON API responses (PaySlipApiapi.asmx,
// Form106Apiapi.asmx). All leaf values (numbers, strings) are stripped to
// placeholders before anything is written to disk - only field NAMES /
// structure are kept, so no salary figures, names, or ID numbers ever
// touch disk or this chat.

import { chromium } from 'playwright';
import readline from 'node:readline';
import fs from 'node:fs';

function prompt(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (mask) {
      let promptShown = false;
      rl._writeToOutput = () => {
        if (!promptShown) { rl.output.write(question); promptShown = true; }
      };
    }
    rl.question(question, (answer) => {
      if (mask) rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

function redactDeep(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return v.length ? '[STR]' : '';
  if (Array.isArray(v)) return v.slice(0, 2).map(redactDeep); // keep at most 2 sample items
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = redactDeep(v[k]);
    return out;
  }
  return '[?]';
}

const orgSubdomain = await prompt('Tenant subdomain (e.g. amdocs) or full https URL: ');
const baseUrl = orgSubdomain.startsWith('http') ? orgSubdomain.replace(/\/$/, '') : `https://${orgSubdomain}.net.hilan.co.il`;

const browser = await chromium.launch({ headless: false, slowMo: 30 });
const page = await browser.newPage();

const captured = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!/\.asmx\//i.test(url)) return;
  try {
    const req = res.request();
    let reqBody = null;
    try { reqBody = req.postData(); } catch {}
    let reqBodyRedacted = null;
    if (reqBody) {
      try { reqBodyRedacted = redactDeep(JSON.parse(reqBody)); }
      catch { reqBodyRedacted = '[non-json body, length=' + reqBody.length + ']'; }
    }
    let json = null;
    try { json = await res.json(); } catch {}
    captured.push({
      url: url.replace(/^https?:\/\/[^/]+/, ''), // strip host (tenant name), keep path
      method: req.method(),
      status: res.status(),
      requestBodyShape: reqBodyRedacted,
      responseShape: json ? redactDeep(json) : '[no json body]',
    });
    console.log('Captured:', req.method(), url.replace(/^https?:\/\/[^/]+/, ''));
  } catch (e) {
    console.log('Failed to capture', url, e.message);
  }
});

await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
const autofill = await prompt('Auto-fill credentials from masked terminal prompts? (y/N): ');
if (autofill.trim().toLowerCase() === 'y') {
  const fields = await page.$$eval('#mainForm input[type="text"], #mainForm input[type="password"]', (els) =>
    els.map((e) => ({ id: e.id, placeholder: e.placeholder }))
  );
  for (const f of fields) {
    if (!f.id) continue;
    const isPassword = f.id.toLowerCase().includes('password');
    const val = await prompt(`  Value for "${f.placeholder || f.id}": `, { mask: isPassword });
    if (val) await page.fill(`#${f.id}`, val);
  }
  const submitBtn = await page.$('#mainForm button[type="submit"]');
  if (submitBtn) await submitBtn.click();
} else {
  console.log('Log in yourself in the browser window.');
}

console.log('Waiting for logged-in state...');
for (let i = 0; i < 100; i++) {
  await page.waitForTimeout(3000);
  if (!page.url().includes('/login')) break;
}
console.log('Logged in. Navigating to payslip and Form 106 screens to trigger their APIs...');

await page.goto(`${baseUrl}/Hilannetv2/ng/personal-file/payslip`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(4000);
await page.goto(`${baseUrl}/Hilannetv2/ng/personal-file/form-106`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(4000);

console.log('\nFeel free to click around a bit more (switch months, open a specific payslip) to capture more calls.');
await prompt('Press Enter when done: ');

fs.writeFileSync('api-shapes.json', JSON.stringify(captured, null, 2));
console.log(`\nSaved ${captured.length} redacted API call shapes to api-shapes.json.`);
await prompt('Press Enter to close browser: ');
await browser.close();
