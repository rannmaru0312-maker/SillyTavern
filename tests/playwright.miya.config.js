import { defineConfig } from '@playwright/test';

export default defineConfig({
    testMatch: 'miya-browser.e2e.js',
    workers: 1,
    fullyParallel: false,
    timeout: 120000,
    expect: { timeout: 10000 },
    outputDir: 'test-results/miya-browser',
    reporter: [['list'], ['json', { outputFile: 'test-results/miya-browser-results.json' }]],
    use: {
        headless: true,
        actionTimeout: 10000,
        viewport: { width: 1440, height: 1000 },
        launchOptions: { executablePath: process.env.MIYA_CHROMIUM_PATH || undefined },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
});
