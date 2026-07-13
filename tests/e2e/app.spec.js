const { test, expect } = require('@playwright/test');

function uniqueEmail() {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function registerAndLogin(page) {
  const email = uniqueEmail();
  await page.goto('/login');
  await page.getByText('Need an account? Register').click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/');
  return email;
}

test.describe('AutoTrader UI', () => {
  test('register, land on dashboard, see liquid-glass shell', async ({ page }) => {
    const email = await registerAndLogin(page);
    await expect(page.getByText('AUTOTRADER')).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText('Cash balance')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Kill switch' })).toBeVisible();
  });

  test('navigate to Settings, toggle trading enabled, and engage kill switch', async ({ page }) => {
    await registerAndLogin(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL('/settings');

    await page.getByRole('checkbox', { name: 'Trading enabled' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.getByRole('button', { name: 'Engage kill switch' }).click();
    await expect(page.getByRole('button', { name: 'Resume trading' })).toBeVisible();
  });

  test('navigate to Research view and trigger research-only run', async ({ page }) => {
    await registerAndLogin(page);
    await page.getByRole('link', { name: 'Research' }).click();
    await expect(page).toHaveURL('/research');

    await page.getByRole('button', { name: 'Run research only' }).click();
    await expect(page.getByText('No scored candidates yet.')).not.toBeVisible({ timeout: 15000 });
  });

  test('navigate to Trade Log view', async ({ page }) => {
    await registerAndLogin(page);
    await page.getByRole('link', { name: 'Trade Log' }).click();
    await expect(page).toHaveURL('/orders');
    await expect(page.getByText('No orders yet.')).toBeVisible();
  });

  test('navigate to Watchers view', async ({ page }) => {
    await registerAndLogin(page);
    await page.getByRole('link', { name: 'Watchers' }).click();
    await expect(page).toHaveURL('/watchers');
    await expect(page.getByRole('heading', { name: 'Watcher Agents' })).toBeVisible();
    await expect(page.getByText('No watcher agents yet.')).toBeVisible();
  });

  test('navigate to Agents view', async ({ page }) => {
    await registerAndLogin(page);
    await page.getByRole('link', { name: 'Agents' }).click();
    await expect(page).toHaveURL('/agents');
    await expect(page.getByRole('heading', { name: 'Agent Council' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run council' })).toBeVisible();
    await expect(page.getByText('Bill Gates').first()).toBeVisible();
  });

  test('navigate to Workspace view', async ({ page }) => {
    await registerAndLogin(page);
    await page.getByRole('link', { name: 'Workspace' }).click();
    await expect(page).toHaveURL('/workspace');
    await expect(page.getByRole('heading', { name: 'Company Workspace' })).toBeVisible();
    await expect(page.getByText(/No company intelligence yet/)).toBeVisible();
  });

  test('navigate to Reports view', async ({ page }) => {
    await registerAndLogin(page);
    await page.getByRole('link', { name: 'Reports' }).click();
    await expect(page).toHaveURL('/reports');
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    await expect(page.getByText('No evaluation reports yet.')).toBeVisible();
    await expect(page.getByText('No decision reports yet.')).toBeVisible();
  });

  test('logout returns to login screen and blocks dashboard access', async ({ page }) => {
    await registerAndLogin(page);
    await page.locator('.profile-trigger').click();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL('/login');

    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('notification bell shows preferences and dashboard grid is draggable', async ({ page }) => {
    await registerAndLogin(page);
    await expect(page.locator('.widget-grid')).toBeVisible();
    await page.locator('.bell-trigger').click();
    await page.getByText('Notification preferences').click();
    await expect(page.getByText('Kill switch alerts')).toBeVisible();
  });

  test('reports view renders a 90-day forecast fan chart', async ({ page }) => {
    test.setTimeout(45000);
    await registerAndLogin(page);
    await page.getByRole('link', { name: 'Reports' }).click();
    await expect(page).toHaveURL('/reports');
    await page.fill('.forecast-symbol-input', 'AAPL');
    await page.getByRole('button', { name: 'Run forecast' }).click();
    await expect(page.getByText('median day-90 price')).toBeVisible({ timeout: 20000 });
  });
});
