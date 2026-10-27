import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createApp} from '../server/app.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const drag = async (page, x1, y1, x2, y2) => {
  await page.locator('.overlay:not(.is-preparing)').waitFor({state: 'visible'});
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, {steps: 8});
  await page.mouse.up();
  if (Math.abs(x2-x1)>=24 && Math.abs(y2-y1)>=24) await page.getByRole('button', {name:'Подтвердить выделение',exact:true}).click();
};

// Run separately from npm test: npm run test:browser (requires installed Chromium).
test('widget browser regressions and reviewer handoff', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-browser-'));
  let kitBase = '';
  const site = createServer((req, res) => {
    if (req.url?.startsWith('/cap.svg')) {
      res.writeHead(200, {'Content-Type': 'image/svg+xml'});
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path fill="#0645db" d="M24 3 2 16l22 13 22-13zM10 27v9c9 11 19 11 28 0v-9l-14 8z"/></svg>');
      return;
    }
    if (req.url?.startsWith('/broken.png')) { res.writeHead(404); res.end(); return; }
    if (req.url?.startsWith('/missing')) { res.writeHead(500); res.end(); return; }
    const authPage = req.url?.startsWith('/auth');
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0">
      <img id="svg-icon" src="/cap.svg" alt="" style="position:absolute;left:40px;top:40px;width:48px;height:48px">
      <span style="position:absolute;left:120px;top:40px"><svg id="rotated-icon" viewBox="0 0 48 48" width="48" height="48" style="transform:rotate(270deg);transform-origin:24px 24px"><rect width="24" height="48" fill="#0645db"/></svg></span>
      <div style="height:1200px;background:white">Начало</div>
      <div id="target" style="height:250px;background:rgb(40,150,80)">Цветная область</div>
      <img src="/broken.png" alt="broken"><div style="height:900px;background:white">Конец</div>
      <script>window.__BUG_REPORT_KIT_REPORTER_PROVIDER__ = () => window.__testReporter || null;</script>
      <script src="${kitBase}/widget.js" data-server-url="${kitBase}" data-project-key="${authPage ? 'auth-key' : 'public-key'}"
        data-label="Report issue" data-capture-fetch-errors="true"
        data-reporter-auth="${authPage ? 'true' : 'false'}"
        data-reporter-name="Участник курса" data-reporter-contact="student@example.test"></script></body></html>`);
  });
  await listen(site);
  const siteOrigin = `http://127.0.0.1:${site.address().port}`;
  const app = createApp({projects: [
    {id: 'browser', name: 'Browser', widgetKey: 'public-key', allowedOrigins: [siteOrigin]},
    {id: 'browser-auth', name: 'Browser Auth', widgetKey: 'auth-key', allowedOrigins: [siteOrigin], reporterAuth: true, panelAccess: true},
  ], reporterAuthSecret: 'browser-fixture-only-secret-value-123456789',
    teamTokens: [
      {name: 'Reviewer', role: 'reviewer', token: 'private-reviewer', projects: ['browser', 'browser-auth']},
      {name: 'Developer', role: 'developer', token: 'private-developer', projects: ['browser']},
    ]},
  {rootDir: process.cwd(), database: join(directory, 'reports.sqlite')});
  await listen(app.server);
  kitBase = `http://127.0.0.1:${app.server.address().port}`;
  let browser;
  try { browser = await chromium.launch({headless: true}); }
  catch (error) { throw new Error(`Chromium не установлен. Выполните npx playwright install chromium. ${error.message}`); }
  t.after(async () => {
    await browser.close();
    await close(app.server);
    app.db.close();
    await close(site);
    rmSync(directory, {recursive: true, force: true});
  });
  const auth = {Authorization: 'Bearer private-reviewer'};
  const detail = async (id) => {
    const response = await fetch(`${kitBase}/api/reports/${id}`, {headers: auth});
    assert.equal(response.status, 200);
    return response.json();
  };
  let firstId;
  let attachmentId;

  await t.test('selected external SVG remains visible in the screenshot', async () => {
    const page = await browser.newPage({viewport: {width: 800, height: 600}});
    try {
      await page.goto(siteOrigin);
      await page.locator('#svg-icon').evaluate((img) => img.decode());
      await page.getByRole('button', {name: 'Report issue'}).click();
      await drag(page, 24, 24, 104, 104);
      const preview = page.locator('img.preview');
      await preview.waitFor({state: 'visible'});
      const bluePixels = await preview.evaluate((img) => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(img, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] < 80 && pixels[i + 1] < 130 && pixels[i + 2] > 150) count += 1;
        }
        return count;
      });
      assert.ok(bluePixels > 100, `SVG disappeared from screenshot: ${bluePixels} blue pixels`);
    } finally { await page.close(); }
  });

  await t.test('inline SVG CSS rotation is applied exactly once', async () => {
    const page = await browser.newPage({viewport:{width:800,height:600}});
    try {
      await page.goto(siteOrigin);
      await page.getByRole('button', {name:'Report issue'}).click();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state:'visible'});
      await drag(page,110,30,180,100);
      const preview=page.locator('img.preview');
      await preview.waitFor({state:'visible'});
      const samples=await preview.evaluate(async img => {
        await img.decode();
        const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
        const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
        const scale=img.naturalWidth/70;
        return [22,46].map(y=>[...ctx.getImageData(Math.round(34*scale),Math.round(y*scale),1,1).data]);
      });
      assert.ok(samples[0][0]>220 && samples[0][1]>220,'top half stays white');
      assert.ok(samples[1][0]<80 && samples[1][2]>150,'bottom half stays blue after one 270-degree rotation');
    } finally {await page.close();}
  });

  await t.test('arbitrary file is stored separately from the selected screenshot', async () => {
    const page = await browser.newPage({viewport: {width: 800, height: 600}});
    const fileBytes = Buffer.from('broken export document');
    try {
      await page.goto(siteOrigin);
      await page.getByRole('button', {name: 'Report issue'}).click();
      await drag(page, 80, 110, 300, 310);
      const preview = page.locator('img.preview');
      await preview.waitFor({state: 'visible'});
      const originalScreenshot = await preview.getAttribute('src');
      await page.locator('input[type=file]').setInputFiles({name: 'wrong-export.docx',
        mimeType: 'application/octet-stream', buffer: fileBytes});
      await page.getByText('wrong-export.docx').waitFor();
      assert.equal(await preview.getAttribute('src'), originalScreenshot);
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').fill('Неверная выгрузка документа');
      const submitted = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.request().method() === 'POST');
      await page.getByRole('button', {name: 'Отправить'}).click();
      const response = await submitted;
      assert.equal(response.status(), 201);
      await page.locator('.report-card').waitFor({state: 'detached'});
      await page.locator('.report-toast').getByText('Баг отправлен').waitFor({state: 'visible'});
      assert.equal(await page.getByRole('button', {name: 'Report issue'}).isVisible(), true);
      const report = await detail((await response.json()).id);
      attachmentId = report.id;
      assert.equal(report.screenshotAvailable, true);
      assert.equal(report.attachmentAvailable, true);
      assert.equal(report.attachmentName, 'wrong-export.docx');
      const downloaded = await fetch(`${kitBase}/api/reports/${report.id}/attachment`, {headers: auth});
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), fileBytes);
    } finally { await page.close(); }
  });

  await t.test('scrolled reverse selection captures correct pixels despite a broken image', async () => {
    const page = await browser.newPage({viewport: {width: 800, height: 600}, deviceScaleFactor: 2});
    try {
      await page.goto(siteOrigin);
      await page.locator('#target').scrollIntoViewIfNeeded();
      await page.getByRole('button', {name: 'Report issue'}).click();
      const rect = await page.locator('#target').boundingBox();
      await drag(page, rect.x + 200, rect.y + 170, rect.x + 30, rect.y + 30);
      const preview = page.locator('img.preview');
      await preview.waitFor({state: 'visible'});
      const pixel = await preview.evaluate((img) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.drawImage(img, img.naturalWidth / 2, img.naturalHeight / 2, 1, 1, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      });
      assert.ok(Math.abs(pixel[0] - 40) <= 3 && Math.abs(pixel[1] - 150) <= 3 && Math.abs(pixel[2] - 80) <= 3, `Wrong crop: ${pixel}`);
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').fill('Browser capture\nСнимок прокрученной страницы\nОткрыть страницу и выделить область');
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').fill('Browser capture\nСнимок прокрученной страницы\nОткрыть страницу и выделить область\nОжидалось: выделенная область видна в снимке');
      const submitted = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.request().method() === 'POST');
      await page.getByRole('button', {name: 'Отправить'}).click();
      const response = await submitted;
      assert.equal(response.status(), 201);
      firstId = (await response.json()).id;
      const report = await detail(firstId);
      assert.equal(report.screenshotAvailable, true);
      assert.equal(report.environment, 'local');
      assert.equal(report.selection.width, 170);
    } finally { await page.close(); }
  });

  await t.test('guest ID persists in one browser and differs in a fresh browser', async () => {
    const submit = async (page, title) => {
      await page.getByRole('button', {name: 'Report issue'}).click();
      await drag(page, 100, 150, 260, 300);
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').fill(`${title}\nПроверка анонимного ID`);
      const submitted = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.status() === 201);
      await page.getByRole('button', {name: 'Отправить'}).click();
      return detail((await (await submitted).json()).id);
    };
    const firstContext = await browser.newContext({viewport: {width: 800, height: 600}});
    const secondContext = await browser.newContext({viewport: {width: 800, height: 600}});
    try {
      const firstPage = await firstContext.newPage();
      await firstPage.goto(siteOrigin);
      const first = await submit(firstPage, 'Гость 1');
      assert.match(first.reporterId, /^anon:[0-9a-f-]{36}$/);
      await firstPage.reload();
      const second = await submit(firstPage, 'Гость 2');
      assert.equal(second.reporterId, first.reporterId);
      const otherPage = await secondContext.newPage();
      await otherPage.goto(siteOrigin);
      const third = await submit(otherPage, 'Другой браузер');
      assert.notEqual(third.reporterId, first.reporterId);
    } finally { await firstContext.close(); await secondContext.close(); }
  });

  await t.test('4-digit PIN reporter authenticates before selection, restores session, and reauthenticates after 401', async () => {
    const context = await browser.newContext({viewport: {width: 800, height: 600}});
    const otherContext = await browser.newContext({viewport: {width: 800, height: 600}});
    const requests = [];
    const page = await context.newPage();
    page.on('request', (request) => {
      if (request.url() === `${kitBase}/api/reports` && request.method() === 'POST') {
        requests.push({headers: request.headers(), body: request.postDataJSON()});
      }
    });
    const reportAfterAuth = async (page, title, authAction) => {
      await page.getByRole('button', {name: 'Report issue'}).click();
      assert.equal(await page.locator('.overlay').count(), 0, 'Auth should open before selecting an area');
      await page.getByPlaceholder('Имя или ник').waitFor({state: 'visible'});
      await page.getByPlaceholder('Имя или ник').fill('Тестировщик один');
      await page.getByLabel('PIN из 4 цифр').fill('1234');
      await page.getByRole('button', {name: authAction}).click();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state: 'visible'});
      assert.equal(await page.getByPlaceholder('Имя или ник').count(), 0,
        'Auth dialog should close before area selection');
      await drag(page, 100, 150, 260, 300);
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').waitFor({state: 'visible'});
      assert.equal(await page.getByText('Можно приложить файл', {exact: false}).count(), 0);
      assert.equal(await page.getByLabel('Прикрепить файл').count(), 1);
      assert.equal(await page.locator('.upload-action svg').count(), 1);
      assert.equal(await page.locator('.report-card .report-field').count(), 1);
      assert.equal(await page.locator('textarea').count(), 1, 'Bug form should contain the combined description and expected result');
      const previewCenterOffset = await page.locator('img.preview').evaluate((image) => {
        const imageRect = image.getBoundingClientRect();
        const cardRect = image.closest('.card').getBoundingClientRect();
        return Math.abs((imageRect.left + imageRect.width / 2) - (cardRect.left + cardRect.width / 2));
      });
      assert.ok(previewCenterOffset <= 4, `Screenshot preview is ${previewCenterOffset}px off the card center`);
      const textarea = page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось');
      assert.equal(await textarea.getAttribute('maxlength'), '4000');
      assert.equal(await page.locator('#bug-kit-description-count').textContent(), '0 / 4000');
      const countSample = 'Описание ошибки и шаги';
      await textarea.fill(countSample);
      assert.equal(await page.locator('#bug-kit-description-count').textContent(), `${countSample.length} / 4000`);
      await textarea.fill(`${title}\nАвторизованный отчёт\nВойти и открыть страницу`);
      assert.equal(await page.locator('.report-fields textarea').count(),1);
      const submitted = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.request().method() === 'POST');
      await page.getByRole('button', {name: 'Отправить'}).click();
      const response = await submitted;
      assert.equal(response.status(), 201);
      await page.locator('.report-card').waitFor({state: 'detached'});
      await page.locator('.report-toast').getByText('Баг отправлен').waitFor({state: 'visible'});
      return detail((await response.json()).id);
    };
    try {
      await page.goto(`${siteOrigin}/auth`);
      const first = await reportAfterAuth(page, 'Reporter auth registration', 'Создать имя');
      assert.match(first.reporterId, /^[0-9a-f-]{36}$/i);
      assert.equal(first.reporterName, 'Тестировщик один');
      assert.equal(first.reporterContact || '', '');
      assert.equal(first.title, 'Reporter auth registration');
      assert.equal('reporterId' in requests[0].body, false);
      assert.equal('reporterName' in requests[0].body, false);
      assert.equal('reporterContact' in requests[0].body, false);
      assert.equal('steps' in requests[0].body, false, 'Reproduction steps stay in the main description field');
      assert.ok(requests[0].headers['x-reporter-token']);

      await page.reload();
      await page.getByRole('button', {name: 'Report issue'}).click();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state: 'visible'});
      assert.equal(await page.getByPlaceholder('Имя или ник').count(), 0,
        'A saved session should skip auth and start selection immediately');
      let expireOnce = true;
      await page.route(`${kitBase}/api/reports`, async (route) => {
        if (route.request().method() === 'POST' && expireOnce) {
          expireOnce = false;
          return route.fulfill({status: 401,
            headers: {'content-type': 'application/json', 'access-control-allow-origin': siteOrigin},
            body: JSON.stringify({error: 'Войдите для отправки бага'})});
        }
        return route.continue();
      });
      const draft = 'Reporter auth restored session\nСессия завершилась при отправке';
      const description = page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось');
      await drag(page, 100, 150, 260, 300);
      await description.fill(draft);
      const capturedScreenshot = await page.locator('img.preview').getAttribute('src');
      assert.equal(await page.getByText('Автор: Тестировщик один').count(), 1);
      await page.getByRole('button', {name: 'Выйти'}).click();
      const signInDialog = page.getByRole('dialog', {name: 'Кто сообщает о баге?'});
      await signInDialog.waitFor({state: 'visible'});
      assert.equal(await page.evaluate(() => localStorage.getItem('bug-report-kit:auth:auth-key')), null);
      await signInDialog.getByRole('button', {name: 'Отмена'}).click();
      await signInDialog.waitFor({state: 'hidden'});
      assert.equal(await page.getByRole('button', {name: 'Войти'}).count(), 1);
      assert.equal(await description.inputValue(), draft, 'Canceling sign-in should preserve the report draft');
      assert.equal(await page.locator('img.preview').getAttribute('src'), capturedScreenshot);

      await page.locator('.reporter-identity').getByRole('button', {name: 'Войти'}).click();
      const reauthDialog = page.getByRole('dialog', {name: 'Кто сообщает о баге?'});
      await reauthDialog.waitFor({state: 'visible'});
      await page.getByPlaceholder('Имя или ник').fill('Тестировщик один');
      await page.getByLabel('PIN из 4 цифр').fill('1234');
      await reauthDialog.getByRole('button', {name: 'Войти'}).click();
      await reauthDialog.waitFor({state: 'hidden'});
      assert.equal(await description.inputValue(), draft, 'Signing in again should preserve the report draft');
      assert.equal(await page.locator('img.preview').getAttribute('src'), capturedScreenshot);
      assert.equal(await page.getByText('Автор: Тестировщик один').count(), 1);

      const expired = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.status() === 401);
      await page.getByRole('button', {name: 'Отправить'}).click();
      await expired;
      const authDialog = page.getByRole('dialog', {name: 'Кто сообщает о баге?'});
      await authDialog.waitFor({state: 'visible'});
      await page.getByPlaceholder('Имя или ник').fill('Тестировщик один');
      await page.getByLabel('PIN из 4 цифр').fill('1234');
      await authDialog.getByRole('button', {name: 'Войти'}).click();
      await authDialog.waitFor({state: 'hidden'});
      assert.equal(await description.inputValue(), draft);
      assert.equal(await page.locator('img.preview').getAttribute('src'), capturedScreenshot);
      const restoredSubmit = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.status() === 201);
      await page.getByRole('button', {name: 'Отправить'}).click();
      const restoredResponse = await restoredSubmit;
      const restoredReport = await detail((await restoredResponse.json()).id);
      assert.equal(restoredReport.reporterId, first.reporterId);

      const missingContext = await browser.newContext({viewport: {width: 800, height: 600}});
      try {
        const errorPage = await missingContext.newPage();
        await errorPage.goto(`${siteOrigin}/auth`);
        await errorPage.getByRole('button', {name: 'Report issue'}).click();
        const authDialog = errorPage.getByRole('dialog', {name: 'Кто сообщает о баге?'});
        const authMessage = errorPage.locator('.auth-card [role="status"]');
        const authName = errorPage.getByPlaceholder('Имя или ник');
        const authPin = errorPage.getByLabel('PIN из 4 цифр');

        await authName.fill('Неизвестный автор');
        await authPin.fill('5678');
        await errorPage.getByRole('button', {name: 'Войти'}).click();
        await authMessage.getByText(/создайте имя/i).waitFor();
        assert.equal(await authName.inputValue(), 'Неизвестный автор');
        assert.equal(await authPin.inputValue(), '5678', 'Unknown-name error should retain both inputs for registration');
        await errorPage.getByRole('button', {name: 'Создать имя'}).click();
        await errorPage.locator('.overlay').waitFor({state: 'visible'});
      } finally { await missingContext.close(); }

      const collisionContext = await browser.newContext({viewport: {width: 800, height: 600}});
      try {
        const collisionPage = await collisionContext.newPage();
        await collisionPage.goto(`${siteOrigin}/auth`);
        await collisionPage.getByRole('button', {name: 'Report issue'}).click();
        const authDialog = collisionPage.getByRole('dialog', {name: 'Кто сообщает о баге?'});
        const authMessage = collisionPage.locator('.auth-card [role="status"]');
        const authName = collisionPage.getByPlaceholder('Имя или ник');
        const authPin = collisionPage.getByLabel('PIN из 4 цифр');
        await authDialog.waitFor({state: 'visible'});
        await authName.fill('Тестировщик один');
        await authPin.fill('0000');
        await collisionPage.getByRole('button', {name: 'Войти'}).click();
        await authMessage.getByText(/Проверьте четыре цифры/i).waitFor();
        assert.equal(await authName.inputValue(), 'Тестировщик один');
        assert.equal(await authPin.inputValue(), '', 'Wrong PIN should clear only the PIN');

        await authPin.fill('9876');
        await collisionPage.getByRole('button', {name: 'Создать имя'}).click();
        await authMessage.getByText(/уже занято.*другое имя/i).waitFor();
        assert.equal(await authName.inputValue(), 'Тестировщик один');
        assert.equal(await authPin.inputValue(), '9876', 'Duplicate-name error should retain both inputs for login or another name');
        await authPin.fill('1234');
        await collisionPage.getByRole('button', {name: 'Войти'}).click();
        await collisionPage.locator('.overlay').waitFor({state: 'visible'});
      } finally { await collisionContext.close(); }

      const otherPage = await otherContext.newPage();
      await otherPage.goto(`${siteOrigin}/auth`);
      const second = await reportAfterAuth(otherPage, 'Reporter auth login', 'Войти');
      assert.equal(second.reporterId, first.reporterId);
      assert.equal(second.reporterName, first.reporterName);
    } finally { await context.close(); await otherContext.close(); }
  });

  await t.test('touch drag keeps an editable frame until confirmation', async () => {
    const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
    const page = await context.newPage();
    try {
      await page.goto(siteOrigin);
      await page.getByRole('button', {name: 'Report issue'}).tap();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state: 'visible'});
      const cdp = await context.newCDPSession(page);
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{x, y, id: 1}],
      });
      await touch('touchStart', 50, 140);
      for (let i = 1; i <= 8; i++) {
        await touch('touchMove', 50 + i * 20, 140 + i * 20);
        await page.waitForTimeout(25);
      }
      await touch('touchEnd', 210, 300);
      assert.equal(await page.locator('.report-card').count(),0);
      await page.getByRole('button',{name:'Подтвердить выделение',exact:true}).tap();
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').waitFor({state: 'visible'});
      assert.equal(await page.locator('.overlay').count(), 0);
    } finally { await context.close(); }
  });

  await t.test('zoom keeps the selected pixels and a small drag can be cancelled', async () => {
    const page = await browser.newPage({viewport: {width: 800, height: 600}, deviceScaleFactor: 2});
    try {
      await page.goto(siteOrigin);
      await page.evaluate(() => {
        const control = document.createElement('button');
        control.id = 'bottom-control';
        control.textContent = 'Save';
        Object.assign(control.style, {position: 'fixed', right: '20px', bottom: '20px', width: '180px', height: '48px'});
        document.body.append(control);
      });
      await page.waitForTimeout(100);
      const positions = await page.evaluate(() => {
        const button = document.querySelector('[data-bug-report-kit]').shadowRoot.querySelector('.launcher').getBoundingClientRect();
        const control = document.querySelector('#bottom-control').getBoundingClientRect();
        return {button: button.toJSON(), control: control.toJSON()};
      });
      assert.ok(positions.button.right <= positions.control.left || positions.button.left >= positions.control.right
        || positions.button.bottom <= positions.control.top || positions.button.top >= positions.control.bottom,
      'Launcher covers a page control');
      await page.getByRole('button', {name: 'Report issue'}).click();
      await drag(page, 80, 120, 90, 130);
      assert.equal(await page.locator('.overlay').count(), 1);
      assert.equal(await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.overlay').count(), 0);
      await page.locator('#target').scrollIntoViewIfNeeded();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setPageScaleFactor', {pageScaleFactor: 2});
      assert.equal(await page.evaluate(() => visualViewport.scale), 2);
      await page.getByRole('button', {name: 'Report issue'}).click();
      const rect = await page.locator('#target').boundingBox();
      await drag(page, 30, rect.y + 20, 180, rect.y + 75);
      const preview = page.locator('img.preview');
      await preview.waitFor({state: 'visible'});
      const pixel = await preview.evaluate((img) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.drawImage(img, img.naturalWidth / 2, img.naturalHeight / 2, 1, 1, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      });
      assert.ok(Math.abs(pixel[0] - 40) <= 3 && Math.abs(pixel[1] - 150) <= 3 && Math.abs(pixel[2] - 80) <= 3,
        `Wrong crop at zoom: ${pixel}`);
    } finally { await page.close(); }
  });

  await t.test('selection cancels on resize and keeps the page still during wheel input', async () => {
    const page = await browser.newPage({viewport:{width:800,height:600}});
    try {
      await page.goto(siteOrigin);
      await page.locator('#target').scrollIntoViewIfNeeded();
      const scrollBefore = await page.evaluate(()=>scrollY);
      await page.getByRole('button',{name:'Report issue'}).click();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state:'visible'});
      await page.mouse.move(400,300); await page.mouse.wheel(0,300);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(()=>scrollY),scrollBefore,'selection must not scroll the hidden live page');
      await page.setViewportSize({width:760,height:580});
      await page.locator('.overlay:not(.is-preparing)').waitFor({state:'detached'});
      assert.equal(await page.locator('img.preview').count(),0);
      await page.getByRole('button',{name:'Report issue'}).click();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state:'visible'});
      await page.locator('.selection-cancel').click();
      assert.equal(await page.locator('.overlay').count(),0);
      await page.getByRole('button',{name:'Report issue'}).click();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state:'visible'});
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.overlay').count(),0);
    } finally {await page.close();}
  });

  await t.test('rapid double click produces only one selection and cleanly reopens after cancel', async () => {
    const page=await browser.newPage({viewport:{width:800,height:600}});
    try {
      await page.goto(siteOrigin);
      await page.getByRole('button',{name:'Report issue'}).dblclick();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state:'visible'});
      assert.equal(await page.locator('.overlay').count(),1);
      await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'Report issue'}).click();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state:'visible'});
      assert.equal(await page.locator('.overlay').count(),1);
      await drag(page,180,220,30,140);
      await page.locator('img.preview').waitFor({state:'visible'});
      assert.equal(await page.locator('.report-card').count(),1);
      await page.locator('.report-card').getByRole('button',{name:'Отмена',exact:true}).click();
      assert.equal(await page.locator('.overlay,.report-card').count(),0);
      await page.getByRole('button',{name:'Report issue'}).click();
      await page.locator('.overlay:not(.is-preparing)').waitFor({state:'visible'});
      await page.locator('.selection-cancel').click();
      assert.equal(await page.locator('.overlay,.report-card').count(),0);
    } finally {await page.close();}
  });

  await t.test('failed capture keeps the screenshot absent while storing a separate file', async () => {
    const page = await browser.newPage({viewport: {width: 800, height: 600}});
    try {
      await page.goto(siteOrigin);
      await page.evaluate(() => { HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('forced failure'); }; });
      await page.getByRole('button', {name: 'Report issue'}).click();
      await drag(page, 100, 150, 320, 340);
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').waitFor({state: 'visible'});
      assert.match((await page.locator('.error').textContent()), /Снимок не получился/);
      assert.equal(await page.locator('img.preview').evaluate((img) => getComputedStyle(img).display), 'none');
      await page.locator('input[type=file]').setInputFiles({name: 'fallback.png', mimeType: 'image/png', buffer: png});
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').fill('Manual image\nСнимок приложен вручную');
      const submitted = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.request().method() === 'POST');
      await page.getByRole('button', {name: 'Отправить'}).click();
      const response = await submitted;
      assert.equal(response.status(), 201);
      const report = await detail((await response.json()).id);
      assert.equal(report.screenshotAvailable, false);
      assert.equal(report.attachmentAvailable, true);
      assert.equal(report.attachmentName, 'fallback.png');
    } finally { await page.close(); }
  });

  await t.test('retry preserves text and strips URL secrets from request and diagnostics', async () => {
    const page = await browser.newPage({viewport: {width: 800, height: 600}});
    let attempts = 0;
    const bodies = [];
    try {
      await page.route(`${kitBase}/api/reports`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        attempts += 1;
        bodies.push(route.request().postDataJSON());
        if (attempts === 1) return route.fulfill({status: 503,
          headers: {'content-type': 'application/json', 'access-control-allow-origin': siteOrigin},
          body: JSON.stringify({error: 'Temporary failure'})});
        return route.continue();
      });
      await page.goto(`${siteOrigin}/?token=secret123#/page?session=secret123`);
      await page.evaluate(() => { window.__testReporter = {id: 'session-user-8', name: 'Автор из активной сессии', contact: 'session@example.test'}; });
      await page.evaluate(async () => { await fetch('/missing?token=secret123'); });
      await page.getByRole('button', {name: 'Report issue'}).click();
      await drag(page, 100, 150, 320, 340);
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').waitFor({state: 'visible'});
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').fill('Retry check\nОписание сохраняется после ошибки\nПовторно отправить после ошибки');
      assert.equal(await page.getByLabel('Кто сообщает').inputValue(), 'Автор из активной сессии');
      assert.equal(await page.getByLabel('Контакт для уточнений (необязательно)').inputValue(), 'session@example.test');
      await page.getByRole('button', {name: 'Отправить'}).click();
      await page.locator('.error').getByText('Temporary failure').waitFor();
      assert.equal(await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').inputValue(), 'Retry check\nОписание сохраняется после ошибки\nПовторно отправить после ошибки');
      const submitted = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.status() === 201);
      await page.getByRole('button', {name: 'Отправить'}).click();
      const response = await submitted;
      assert.equal(attempts, 2);
      assert.equal(bodies[0].pageUrl, `${siteOrigin}/#/page`);
      assert.equal(JSON.stringify(bodies).includes('secret123'), false);
      const report = await detail((await response.json()).id);
      assert.equal(report.reporterName, 'Автор из активной сессии');
      assert.equal(report.reporterContact, 'session@example.test');
      assert.equal(report.reporterId, 'session-user-8');
      assert.doesNotMatch(JSON.stringify(bodies), /secret123|sessionToken/);
      assert.equal(JSON.stringify(report).includes('secret123'), false);
      assert.ok(report.diagnostics.some((item) => item.path === '/missing' && item.statusCode === 500));
    } finally { await page.close(); }
  });

  await t.test('network outage keeps the form ready for retry', async () => {
    const page = await browser.newPage({viewport: {width: 800, height: 600}});
    let attempts = 0;
    try {
      await page.route(`${kitBase}/api/reports`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        attempts += 1;
        if (attempts === 1) return route.abort('failed');
        return route.continue();
      });
      await page.goto(siteOrigin);
      await page.getByRole('button', {name: 'Report issue'}).click();
      await drag(page, 100, 150, 320, 340);
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').waitFor({state: 'visible'});
      await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').fill('Offline check\nОписание при отсутствии сети');
      await page.getByRole('button', {name: 'Отправить'}).click();
      await page.locator('.error').getByText(/Не удалось связаться с сервером/).waitFor();
      assert.equal(await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').inputValue(), 'Offline check\nОписание при отсутствии сети');
      const submitted = page.waitForResponse((response) => response.url() === `${kitBase}/api/reports` && response.status() === 201);
      await page.getByRole('button', {name: 'Отправить'}).click();
      await submitted;
      assert.equal(attempts, 2);
    } finally { await page.close(); }
  });

  await t.test('queue highlights the bug, then reviewer accepts a verified fix', async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => sessionStorage.setItem('bug-kit-panel-token', 'private-reviewer'));
      await page.goto(kitBase);
      await page.locator('.item').filter({hasText: 'Неверная выгрузка документа'}).click();
      await page.getByText('Вложение: wrong-export.docx', {exact: false}).waitFor();
      const fileDownload = page.waitForEvent('download');
      await page.getByRole('button', {name: 'Скачать файл'}).click();
      assert.equal((await fileDownload).suggestedFilename(), 'wrong-export.docx');
      assert.equal((await detail(attachmentId)).attachmentAvailable, true);
      const htmlPage = await browser.newPage({extraHTTPHeaders: auth});
      try {
        await htmlPage.goto(`${kitBase}/api/reports/${attachmentId}/html`);
        const htmlDownload = htmlPage.waitForEvent('download');
        await htmlPage.getByRole('link', {name: 'wrong-export.docx'}).click();
        assert.equal((await htmlDownload).suggestedFilename(), 'wrong-export.docx');
      } finally { await htmlPage.close(); }
      await page.locator('.item').filter({hasText: 'Browser capture'}).click();
      assert.equal(await page.locator('#detail').getByText('Описание').isVisible(), true);
      assert.equal(await page.locator('#detail').getByText('Код и проверки').count(), 0);
      assert.equal(await page.locator('#header-session').isVisible(), true);
      assert.equal(await page.getByRole('link', {name: 'Выйти'}).isVisible(), true);
      assert.equal(await page.locator('.toolbar').count(), 1);
      assert.equal(await page.locator('.period-report').count(), 0);
      assert.equal(await page.locator('#filter option:checked').textContent(), 'Все баги');
      assert.equal(await page.getByLabel('Отчёт с даты').isVisible(), true);
      await page.getByRole('button', {name: 'Обновить очередь'}).click();
      const developerHeaders = {Authorization: 'Bearer private-developer', 'Content-Type': 'application/json'};
      const update = async (action, values = {}) => {
        const report = await detail(firstId);
        const response = await fetch(`${kitBase}/api/reports/${firstId}`, {method: 'PATCH',
          headers: developerHeaders,
          body: JSON.stringify({revision: report.revision, action, ...values})});
        assert.equal(response.status, 200);
      };
      await update('claim');
      await update('start');
      await update('resolve', {rootCause: 'Не работал обработчик', resolution: 'Обработчик исправлен',
        fixEvidence: {repositories: [{name: 'web', ref: 'abc123'}],
          checks: [{name: 'smoke', result: 'passed'}]}});
      await page.reload();
      await page.getByText('Что исправлено').waitFor();
      assert.equal(await page.getByText('Обработчик исправлен').isVisible(), true);
      await page.getByRole('button', {name: 'Принять исправление'}).click();
      await page.getByText('Укажите результат проверки или замечание.').waitFor();
      await page.getByLabel('Результат проверки или замечание').fill('Проверено в браузере');
      await page.getByRole('button', {name: 'Принять исправление'}).click();
      await page.waitForFunction(() => document.querySelector('#message')?.textContent === 'Сохранено');
      assert.equal((await detail(firstId)).status, 'closed');
      await page.locator('.technical').evaluate((node) => { node.open = true; });
      await page.locator('#detail').getByRole('button', {name: 'Открыть HTML-отчёт'}).waitFor();
      const year = new Date().getFullYear();
      await page.getByLabel('Отчёт с даты').fill(`${year}-01-01`);
      await page.getByLabel('Отчёт по дату').fill(`${year}-12-31`);
      const periodResponsePromise = page.waitForResponse((response) => response.url().includes('/api/summary/html?'));
      const periodPagePromise = page.waitForEvent('popup');
      await page.locator('#summary-html').click();
      const periodResponse = await periodResponsePromise;
      assert.equal(new URL(periodResponse.url()).searchParams.get('from'), `${year}-01-01`);
      assert.equal(new URL(periodResponse.url()).searchParams.get('to'), `${year}-12-31`);
      const periodPage = await periodPagePromise;
      await periodPage.waitForLoadState();
      assert.match(await periodPage.title(), /Исправленные баги/);
      await periodPage.close();
      const html = await fetch(`${kitBase}/api/reports/${firstId}/html`, {headers: auth});
      assert.equal(html.status, 200);
      assert.match(await html.text(), /Browser capture/);
    } finally { await page.close(); }
  });

  await t.test('same reporter name and PIN open only its project in the panel', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(kitBase);
      await page.locator('#login-name').fill('Тестировщик один');
      await page.locator('#login-pin').fill('1234');
      await page.getByRole('button', {name: 'Войти'}).click();
      await page.locator('.item').filter({hasText: 'Reporter auth registration'}).waitFor();
      assert.equal(await page.locator('.item').filter({hasText: 'Неверная выгрузка документа'}).count(), 0);
      await page.getByRole('link', {name: 'Выйти'}).click();
      await page.locator('#login').waitFor({state: 'visible'});
    } finally { await page.close(); }
  });
});
