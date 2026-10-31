import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMiyaBrowserEnvironment } from './util/miya-browser-environment.js';

let environment;
test.beforeAll(async () => { environment = await startMiyaBrowserEnvironment(); });
test.afterAll(async () => { await environment?.stop(); });
test.beforeEach(async ({ context }) => {
    await context.route('**/*', route => new URL(route.request().url()).origin === environment.baseURL ? route.continue() : route.abort());
});
test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
        await info.attach('isolated-server.log', { body: environment.logs(), contentType: 'text/plain' });
    }
});

async function login(page, handle = 'fictional_ui_a') {
    await page.goto(environment.baseURL + '/login');
    await page.locator('#userHandle').fill(handle);
    await page.locator('#userPassword').fill('fictional-ui-password');
    await page.locator('#loginButton').click();
    await expect(page).toHaveURL(environment.baseURL + '/');
    await expect(page.locator('#preloader')).toHaveCount(0);
}

async function userMenu(page) {
    await page.locator('#user-settings-button > .drawer-toggle').click();
}

async function logout(page) {
    await userMenu(page);
    await page.locator('#logout_button').click();
    await expect(page).toHaveURL(/\/login/);
}

async function selectCharacter(page, name) {
    if (!await page.locator('#rm_button_characters').isVisible()) await page.locator('#rightNavHolder > .drawer-toggle').click();
    await page.locator('#rm_button_characters').click();
    await page.locator('.character_select').filter({ has: page.locator('.ch_name', { hasText: name }) }).click();
    await expect(page.locator('#chat .mes_text').first()).toContainText(name);
    await page.locator('#miya-return-to-chat').click();
}

async function connectMock(page) {
    await page.locator('#sys-settings-button > .drawer-toggle').click();
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(environment.mockURL);
    await page.locator('#custom_api_url_text').press('Tab');
    await page.locator('#custom_model_id').fill('fictional-local-model');
    await page.locator('#custom_model_id').press('Tab');
    await page.locator('#api_button_openai').click();
    await expect(page.locator('#openai_api .online_status_text')).toContainText('Valid');
    await page.locator('#sys-settings-button > .drawer-toggle').click();
}

test('UI: invalid login, account identity, logout and old-cookie refusal', async ({ page, context, browser }) => {
    await page.goto(environment.baseURL + '/login');
    await page.locator('#userHandle').fill('fictional_ui_a');
    await page.locator('#userPassword').fill('wrong-fictional-password');
    await page.locator('#loginButton').click();
    await expect(page.locator('#errorMessage')).not.toBeEmpty();
    await expect(page).toHaveURL(/\/login/);
    await login(page);
    await userMenu(page);
    await page.locator('#account_button').click();
    await expect(page.locator('.popup .userHandle')).toHaveText('fictional_ui_a');
    await page.locator('.popup-button-ok').click();
    await userMenu(page);
    const cookies = await context.cookies();
    await logout(page);
    const replay = await browser.newContext();
    try {
        await replay.addCookies(cookies);
        const denied = await replay.request.get(environment.baseURL + '/api/users/me');
        expect(denied.status()).toBe(403);
    } finally { await replay.close(); }
});

test('UI: local mock conversation, reload/relogin and MIYA/KOHARU isolation', async ({ page }) => {
    await login(page);
    await connectMock(page);
    await selectCharacter(page, 'みや');
    const miyaMessage = 'MIYA_ONLY_MESSAGE: 架空の天気について話そう。';
    await page.locator('#send_textarea').fill(miyaMessage);
    await page.locator('#send_but').click();
    await expect(page.locator('#chat .mes_text').last()).toContainText('LOCAL MOCK: ' + miyaMessage);
    expect(JSON.stringify(environment.prompts.at(-1))).toContain('MIYA_CONTEXT_ONLY');
    expect(JSON.stringify(environment.prompts.at(-1))).not.toContain('KOHARU_CONTEXT_ONLY');
    await expect(page.locator('#send_but')).toBeVisible();
    await page.reload();
    await expect(page.locator('#preloader')).toHaveCount(0);
    await expect(page.locator('#chat')).toContainText('LOCAL MOCK: ' + miyaMessage);
    await connectMock(page);
    await selectCharacter(page, '小春');
    await expect(page.locator('#chat')).not.toContainText(miyaMessage);
    await page.locator('#send_textarea').fill('KOHARU_ONLY_MESSAGE: 架空の散歩の話。');
    await page.locator('#send_but').click();
    await expect(page.locator('#chat .mes_text').last()).toContainText('LOCAL MOCK: KOHARU_ONLY_MESSAGE');
    const koharuPrompt = JSON.stringify(environment.prompts.at(-1));
    expect(koharuPrompt).toContain('KOHARU_CONTEXT_ONLY');
    expect(koharuPrompt).not.toContain('MIYA_CONTEXT_ONLY');
    expect(koharuPrompt).not.toContain(miyaMessage);
    await logout(page);
    await login(page);
    await selectCharacter(page, 'みや');
    await expect(page.locator('#chat')).toContainText(miyaMessage);
    await expect(page.locator('#chat')).not.toContainText('KOHARU_ONLY_MESSAGE');
    // Disk assertions supplement UI observations: separate persisted chat roots.
    for (const id of ['miya', 'koharu']) {
        expect(fs.readdirSync(path.join(environment.root, 'data/fictional_ui_a/chats', id)).some(file => file.endsWith('.jsonl'))).toBe(true);
    }
});

test('UI: conversation creates a pending memory, duplicate is refused, and approval persists', async ({ page }) => {
    await login(page);
    await connectMock(page);
    await selectCharacter(page, 'みや');
    const text = '私は架空の青いお茶が好きです。';
    const created = page.waitForResponse(response => response.url().endsWith('/candidate-v3') && response.request().method() === 'POST');
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_but').click();
    expect((await created).status()).toBe(201);
    await expect(page.locator('#chat .mes_text').last()).toContainText('LOCAL MOCK: ' + text);
    const characterFile = path.join(environment.root, 'plugins/miya-memory/runtime-data/users/fictional_ui_a/characters/miya.json');
    expect(JSON.parse(fs.readFileSync(characterFile, 'utf8')).memories).toEqual([]);
    await page.locator('#miya-memory-panel > button').first().click();
    const pending = page.locator('#miya-memory-panel li').filter({ hasText: text });
    await expect(pending).toHaveCount(1);
    await expect(pending).toContainText('承認待ち');
    const duplicate = page.waitForResponse(response => response.url().endsWith('/candidate-v3') && response.request().method() === 'POST');
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_but').click();
    expect((await duplicate).status()).toBe(409);
    await expect(pending).toHaveCount(1);
    const approved = page.waitForResponse(response => response.url().endsWith('/decision-v3') && response.request().method() === 'POST');
    await pending.getByRole('button', { name: '承認', exact: true }).click();
    expect((await approved).status()).toBe(200);
    await expect(pending).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(characterFile, 'utf8')).memories.map(item => item.text)).toEqual([text]);
    await page.reload();
    await expect(page.locator('#preloader')).toHaveCount(0);
    await logout(page);
    await login(page);
    await selectCharacter(page, 'みや');
    await expect(page.locator('#chat')).toContainText(text);
    await page.locator('#miya-memory-panel > button').first().click();
    await expect(page.locator('#miya-memory-panel-content')).toContainText('記憶候補はありません');
    expect(JSON.parse(fs.readFileSync(characterFile, 'utf8')).memories.map(item => item.text)).toEqual([text]);
    await logout(page);
    await login(page, 'fictional_ui_b');
    await selectCharacter(page, 'みや');
    await expect(page.locator('#chat')).not.toContainText(text);
    await page.locator('#miya-memory-panel > button').first().click();
    await expect(page.locator('#miya-memory-panel-content')).toContainText('記憶候補はありません');
});

// Explicit coverage gaps are skipped, never counted as successful UI checks.
// eslint-disable-next-line playwright/no-skipped-test, playwright/expect-expect
test.skip('UI approved-memory list/reuse: no MIYA approved-memory view or prompt integration exists', async () => {});
// eslint-disable-next-line playwright/no-skipped-test, playwright/expect-expect
test.skip('UI memory deletion: no MIYA delete UI or delete API exists', async () => {});
