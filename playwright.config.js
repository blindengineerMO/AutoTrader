const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node src/server/index.js',
      port: 3000,
      cwd: __dirname,
      reuseExistingServer: false,
      env: { DB_PATH: `${__dirname}/data/e2e.db` },
    },
    {
      command: 'npm run dev',
      port: 5173,
      cwd: `${__dirname}/frontend`,
      reuseExistingServer: false,
    },
  ],
});
