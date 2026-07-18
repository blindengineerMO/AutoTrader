const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto('http://localhost:3000/login');
  await page.fill('input[type="email"]', 'admin@autotrader.local');
  await page.fill('input[type="password"]', 'ChangeMeAdmin123!');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);

  await page.goto('http://localhost:3000/settings');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/investing-mode-initial.png' });

  const bodyText1 = await page.locator('body').innerText();
  console.log('Panel visible:', bodyText1.includes('Investing mode'));
  console.log('Default label visible:', bodyText1.includes('Balanced'));

  // drag slider thumb to far right (Conservative)
  const thumb = page.locator('.v-slider-thumb').first();
  const track = page.locator('.v-slider-track').first();
  const box = await track.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/investing-mode-conservative.png' });
  const bodyText2 = await page.locator('body').innerText();
  console.log('Conservative label visible after drag:', bodyText2.includes('Conservative'));

  // verify persisted via API
  const settingsResp = await page.evaluate(async () => {
    const res = await fetch('/api/settings', { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }, credentials: 'include' });
    return res.status;
  });
  console.log('settings fetch status (informational):', settingsResp);

  await page.reload();
  await page.waitForTimeout(1500);
  const bodyText3 = await page.locator('body').innerText();
  console.log('Conservative label persisted after reload:', bodyText3.includes('Conservative'));

  console.log('Console errors:', JSON.stringify(consoleErrors, null, 2));

  await browser.close();
})().catch((err) => {
  console.error('SCRIPT ERROR', err);
  process.exit(1);
});
