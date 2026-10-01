/* eslint-disable @typescript-eslint/no-require-imports -- Portable external Playwright runtime. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1536, height: 1080 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded' });
    await page.getByText('Signal server connected', { exact: true }).waitFor();
    const workflows = [];
    for (const [scenario, mode] of process.env.LIVE_API_TEST === '1' ? [['Wheelchair', 'single'], ['Crutches', 'two_turn']] : [['Wheelchair', 'rules'], ['Crutches', 'rules']]) {
      await page.locator('button[aria-pressed]').filter({ hasText: scenario }).first().click();
      await page.getByRole('combobox', { name: /^Generation mode/ }).selectOption(mode);
      await page.getByRole('button', { name: 'Send signals & run', exact: true }).click();
      await page.getByRole('button', { name: 'View full JSON', exact: true }).waitFor();
      await page.getByRole('button', { name: 'View full JSON', exact: true }).click({ timeout: 45000 });
      const result = JSON.parse(await page.locator('dialog .jsonCode').innerText());
      assert.equal(result.meta.validation_passed, true);
      assert.equal(result.passenger_communication.language, 'en-SG');
      assert.doesNotMatch(JSON.stringify(result), /\p{Script=Han}/u, 'All generated output should be in English');
      if (scenario === 'Wheelchair') assert.ok(result.action_plan.some(a => a.action === 'DEPLOY_AUTOMATIC_SHORT_RAMP'));
      else assert.ok(!result.action_plan.some(a => a.action === 'DEPLOY_AUTOMATIC_SHORT_RAMP'));
      if (process.env.LIVE_API_TEST === '1') assert.equal(result.meta.source, 'llm');
      workflows.push({ scenario, mode, meta: result.meta, actions: result.action_plan.map(a => a.action) });
      await page.getByRole('button', { name: 'Close dialog' }).click();
    }
    await fs.mkdir('outputs', { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'outputs/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'outputs/mobile.png', fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.doesNotMatch(await page.locator('body').innerText(), /\p{Script=Han}/u, 'The visible interface should be in English');
    assert.equal(overflow, false, 'Mobile page should not overflow horizontally');
    assert.deepEqual(errors, []);
    await fs.writeFile('outputs/browser-check.json', JSON.stringify({ workflows, pageErrors: errors, mobileHorizontalOverflow: overflow }, null, 2));
    console.log(JSON.stringify({ workflows, pageErrors: errors, mobileHorizontalOverflow: overflow }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
