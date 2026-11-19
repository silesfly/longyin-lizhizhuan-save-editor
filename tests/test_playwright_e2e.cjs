'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
function loadPlaywright() {
  for (const mod of [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    path.join(os.homedir(), '.local', 'lib', 'node_modules', '@playwright', 'mcp', 'node_modules', 'playwright'),
  ].filter(Boolean)) {
    try {
      return require(mod);
    } catch (_) {}
  }
  throw new Error('Playwright package not found');
}

const { chromium } = loadPlaywright();

const projectDir = path.resolve(__dirname, '..');
const offlineHtml = path.join(
  projectDir,
  'dist',
  'LongYinSaveEditor-v1.0.0.html',
);
const editorScript = process.env.LYZ_EDITOR_SCRIPT
  ? path.resolve(process.env.LYZ_EDITOR_SCRIPT)
  : path.join(projectDir, 'lyz_editor.py');

let browser;
let tempDir;
let server;
let baseUrl;

before(async () => {
  const chromePath = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) =>
    fs.existsSync(p),
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }

  if (browser) await browser.close();
  if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
});

function createPageRecorder(page, allowedLocalUrls = []) {
  const externalRequests = [];
  const pageErrors = [];
  const consoleErrors = [];

  const isLocalUrl = (url) => {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'file:' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '::1' ||
        allowedLocalUrls.some((allowed) => url.startsWith(allowed))
      );
    } catch {
      return true;
    }
  };

  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/i.test(url) && !isLocalUrl(url)) {
      externalRequests.push(url);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  return { externalRequests, pageErrors, consoleErrors };
}

function assertNoBrowserErrors(recorder) {
  assert.deepEqual(recorder.externalRequests, [], 'unexpected external requests');
  assert.deepEqual(recorder.pageErrors, [], 'unexpected uncaught page errors');
  assert.deepEqual(recorder.consoleErrors, [], 'unexpected console errors');
}

async function editVisibleField(page, preferredNames = []) {
  for (const name of preferredNames) {
    const byName = page.locator(
      `input[name*="${name}" i], textarea[name*="${name}" i], ` +
        `input[id*="${name}" i], textarea[id*="${name}" i]`,
    );
    const count = await byName.count();
    for (let i = 0; i < count; i += 1) {
      const field = byName.nth(i);
      if (
        (await field.isVisible().catch(() => false)) &&
        (await field.isEnabled().catch(() => false))
      ) {
        await field.fill('용윤 테스트');
        return field;
      }
    }
  }

  const fields = page.locator(
    '#hero-detail-form input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), ' +
      'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]), textarea',
  );
  const count = await fields.count();
  for (let i = 0; i < count; i += 1) {
    const field = fields.nth(i);
    if (
      (await field.isVisible().catch(() => false)) &&
      (await field.isEnabled().catch(() => false)) &&
      (await field.getAttribute('readonly')) === null
    ) {
      const type = (await field.getAttribute('type')) || 'text';
      if (type === 'number') {
        const current = Number(await field.inputValue().catch(() => '0')) || 0;
        await field.fill(String(current + 1));
      } else {
        await field.fill('용윤 수정');
      }
      await field.dispatchEvent('change');
      return field;
    }
  }

  assert.fail('Could not find a visible, editable field');
}

async function clickAllEditorTabs(page) {
  let tabs = page.getByRole('tab');
  let count = await tabs.count();

  if (count === 0) {
    tabs = page.locator('.tab-button');
    count = await tabs.count();
  }

  assert.equal(count, 7, `expected 7 editor tabs, found ${count}`);

  for (let i = 0; i < count; i += 1) {
    const tab = tabs.nth(i);
    await tab.click();
    await assert.doesNotReject(() => tab.isVisible());
  }
}

async function waitForServerUrl(child) {
  let output = '';
  let startupError = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    startupError += chunk;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const urlMatch = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i);
    if (urlMatch) return urlMatch[0];

    const portMatch =
      output.match(/\b(?:port|listening on|running on)\D{0,30}(\d{2,5})\b/i) ||
      output.match(/\b(?:127\.0\.0\.1|localhost):(\d{2,5})\b/i);
    if (portMatch) {
      const port = Number(portMatch[1]);
      if (port > 0 && port <= 65535) return `http://127.0.0.1:${port}`;
    }

    if (child.exitCode !== null) {
      throw new Error(
        `lyz_editor.py exited during startup (${child.exitCode}).\n` +
          `stdout:\n${output}\nstderr:\n${startupError}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for lyz_editor.py to report its port.\n` +
      `stdout:\n${output}\nstderr:\n${startupError}`,
  );
}

test('Mode A: offline HTML editor', async () => {
  await fs.promises.access(offlineHtml);

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const recorder = createPageRecorder(page);

  try {
    await page.goto(`file://${offlineHtml}`, { waitUntil: 'load' });

    await page.locator('#conn-badge').waitFor({ state: 'visible' });
    assert.equal(
      (await page.locator('#conn-badge').innerText()).trim(),
      '오프라인 준비',
    );

    const theme = page.locator('#theme-select');
    await theme.selectOption('dark');
    assert.equal(await theme.inputValue(), 'dark');
    await theme.selectOption('light');
    assert.equal(await theme.inputValue(), 'light');

    const initialFocus = await page.evaluate(() => document.activeElement?.id || '');
    await page.keyboard.press('Tab');
    const afterTab = await page.evaluate(() => document.activeElement?.id || '');
    assert.notEqual(afterTab, initialFocus, 'Tab should move keyboard focus');

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');

    await page.locator('#btn-load-demo').click();
    await clickAllEditorTabs(page);
    await page.locator('#tab-heroes').click();
    await editVisibleField(page, ['heroName']);
    await page.locator('#tab-save').click();

    await page.locator('#btn-preview-diff').click();
    const diffModal = page.locator('#diff-modal');
    await diffModal.waitFor({ state: 'visible' });
    await page.locator('#btn-close-diff').click();
    await diffModal.waitFor({ state: 'hidden' });

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-download-all').click();
    const download = await downloadPromise;
    assert.ok(download.suggestedFilename(), 'download should have a filename');

    assertNoBrowserErrors(recorder);
  } finally {
    await context.close();
  }
});

test('Mode B: local server editor saves changes and creates a backup', async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lyz-playwright-'));
  const slotDir = path.join(tempDir, 'SaveSlot0');
  await fs.promises.mkdir(slotDir, { recursive: true });

  const info = {
    SaveVersion: '1.0.0',
    SaveTime: '2026-11-20T00:00:00.000Z',
    SaveDetail: {},
  };
  const save = {
    chapter: 1,
    worldTime: { year: 1, month: 1, day: 1 },
    speEnhanceStone: 10,
  };
  const hero = {
    heroID: 0,
    heroName: '용윤',
    heroFamilyName: '용',
    hp: 100,
    maxhp: 100,
    baseAttri: [10, 10, 10, 10, 10, 10],
    maxAttri: [10, 10, 10, 10, 10, 10],
    baseFightSkill: [10, 10, 10, 10, 10, 10, 10, 10, 10],
    maxFightSkill: [10, 10, 10, 10, 10, 10, 10, 10, 10],
    baseLivingSkill: [10, 10, 10, 10, 10, 10, 10, 10, 10],
    maxLivingSkill: [10, 10, 10, 10, 10, 10, 10, 10, 10],
    kungfuSkills: [],
    attackSkillSaveRecord: [-1, -1, -1, -1, -1, -1, -1, -1],
    heroTagData: [],
    itemListData: { money: 100, maxWeight: 100, allItem: [] },
    equipSkills: {},
  };
  const tempHero = [];

  for (const [filename, value] of [
    ['Info', info],
    ['Save', save],
    ['Hero', [hero, null]],
    ['TempHero', tempHero],
  ]) {
    await fs.promises.writeFile(
      path.join(slotDir, filename),
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
  }

  await fs.promises.access(editorScript);
  server = spawn(
    process.env.PYTHON || 'python3',
    [
      editorScript,
      'serve',
      '--save-dir',
      tempDir,
      '--port',
      '0',
      '--no-browser',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
    },
  );
  baseUrl = await waitForServerUrl(server);

  const context = await browser.newContext();
  const page = await context.newPage();
  const recorder = createPageRecorder(page, [baseUrl]);

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    await page.locator('#conn-badge').waitFor({ state: 'visible' });
    assert.equal(
      (await page.locator('#conn-badge').innerText()).trim(),
      '로컬 서버 연결됨',
    );

    const slotSelect = page.locator(
      '#srv-slot-select, select[name*="slot" i], select[id*="slot" i]',
    );
    await slotSelect.first().waitFor({ state: 'visible' });
    const options = await slotSelect.first().locator('option').evaluateAll((items) =>
      items.map((item) => ({ value: item.value, text: item.textContent.trim() })),
    );
    const slotOption = options.find(
      (option) =>
        option.value === 'SaveSlot0' ||
        option.text === 'SaveSlot0' ||
        /SaveSlot0/.test(option.text),
    );
    assert.ok(slotOption, 'SaveSlot0 should be available in the slot selector');
    await slotSelect.first().selectOption(slotOption.value);

    await page.locator('#btn-srv-load').click();
    await page.locator('#slot-summary .field-grid, #hero-list-tbody tr').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await page.locator('#tab-heroes').click();
    await editVisibleField(page, ['heroName']);
    await page.locator('#tab-save').click();

    await page.locator('#btn-srv-save').click();
    await page.locator('#backup-list button').first().waitFor({ state: 'visible', timeout: 5000 });
    const backupItems = page.locator('#backup-list button');
    assert.ok(
      (await backupItems.count()) >= 1,
      'backup list should contain at least one entry',
    );

    const savedHero = JSON.parse(
      await fs.promises.readFile(path.join(slotDir, 'Hero'), 'utf8'),
    );
    assert.notDeepEqual(savedHero[0], hero, 'Hero JSON on disk should be updated');

    const backupDir = path.join(tempDir, '.lyz_backups');
    const backupStat = await fs.promises.stat(backupDir);
    assert.ok(backupStat.isDirectory(), '.lyz_backups should exist');

    assertNoBrowserErrors(recorder);
  } finally {
    await context.close();
  }
});
