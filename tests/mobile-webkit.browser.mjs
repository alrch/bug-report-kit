import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webkit} from 'playwright';
import {createApp} from '../server/app.mjs';

// Real WebKit touch events and rendering, with an isolated TEST database.
// Headless mobile emulation does not emulate the native iOS keyboard or pinch UI.
test('mobile WebKit touch entry, capture and focus regressions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kit-webkit-independent-'));
  let kitBase;
  const site = createServer((req, res) => {
    const auth = req.url === '/auth';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;height:2400px;background:white}#target{position:absolute;left:50px;top:${auth ? 1000 : 600}px;width:260px;height:200px;background:rgb(40,150,80)}</style><div id="target"></div><script src="${kitBase}/widget.js" data-server-url="${kitBase}" data-project-key="${auth ? 'webkit-auth' : 'webkit-public'}" data-reporter-auth="${auth}" data-launcher-style="compact"></script>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const app = createApp({
    projects: [
      {id: 'webkit-public', widgetKey: 'webkit-public', allowedOrigins: [origin]},
      {id: 'webkit-auth', widgetKey: 'webkit-auth', allowedOrigins: [origin], reporterAuth: true},
    ],
    reporterAuthSecret: 'webkit-isolated-fixture-secret-1234567890',
    teamTokens: [{token: 'webkit-fixture-developer', role: 'developer', projects: ['webkit-public', 'webkit-auth']}],
  }, {rootDir: process.cwd(), database: join(directory, 'reports.sqlite')});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  kitBase = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await webkit.launch({headless: true});
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
    await new Promise(resolve => site.close(resolve));
    rmSync(directory, {recursive: true, force: true});
  });
  const pageFor = async (scope, path = '/') => {
    const context = await browser.newContext({viewport: {width:390, height:699}, deviceScaleFactor:3, isMobile:true, hasTouch:true});
    scope.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(origin + path);
    await page.evaluate(() => scrollTo(0,450));
    return page;
  };
  const enter = async page => {
    await page.getByRole('button', {name:'Сообщить о баге', exact:true}).tap();
    await page.locator('.overlay:not(.is-preparing)').waitFor();
  };
  const pixel = (page, x, y) => page.locator('.overlay canvas').evaluate((canvas, p) => {
    const scale = canvas.width / innerWidth;
    return [...canvas.getContext('2d').getImageData(p.x*scale,p.y*scale,1,1).data];
  }, {x,y});
  const mobileForm = async page => {
    const form = page.locator('.report-card');
    await form.waitFor();
    const state = await form.evaluate(card => {
      const rect = card.getBoundingClientRect();
      return {fonts:[...card.querySelectorAll('input,textarea')].map(el=>parseFloat(getComputedStyle(el).fontSize)),
        focus:document.activeElement.tagName, coarse:matchMedia('(pointer:coarse)').matches,
        x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight};
    });
    assert.ok(state.coarse);
    assert.equal(state.focus,'BODY','mobile form must not autofocus and open the keyboard');
    assert.ok(state.fonts.length && state.fonts.every(size=>size>=16),'editable fields must be at least16px');
    assert.ok(state.x>=0 && state.y>=0 && state.right<=state.width+1 && state.bottom<=state.height+1,'form fits the visible screen');
  };

  await t.test('real touch opens compact launcher; scrolled frame and crop align', async scope => {
    const page = await pageFor(scope);
    await enter(page); // No synthetic click or preventDefault override: WebKit compatibility click matters.
    assert.equal(await page.evaluate(()=>scrollY),450);
    assert.deepEqual(await pixel(page,100,200),[40,150,80,255]);
    assert.equal(await page.locator('.overlay').evaluate(el=>getComputedStyle(el).touchAction),'pinch-zoom');
    await page.mouse.move(80,170); await page.mouse.down();
    await page.mouse.move(200,300,{steps:8}); await page.mouse.up();
    await page.getByRole('button',{name:'Подтвердить выделение',exact:true}).tap();
    const preview = page.locator('img.preview'); await preview.waitFor();
    const cropped = await preview.evaluate(async img => {
      await img.decode(); const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,img.naturalWidth/2,img.naturalHeight/2,1,1,0,0,1,1);
      return [...ctx.getImageData(0,0,1,1).data];
    });
    assert.ok(Math.abs(cropped[0]-40)<=3 && Math.abs(cropped[1]-150)<=3 && Math.abs(cropped[2]-80)<=3,`wrong cropped target: ${cropped}`);
    await mobileForm(page);
    assert.equal(await page.evaluate(()=>scrollY),450);
  });
  await t.test('touch cancellation and reopening preserve document scroll and scale', async scope => {
    const page = await pageFor(scope);
    const before = await page.evaluate(()=>({scrollY,scale:visualViewport.scale}));
    await enter(page);
    await page.getByRole('button',{name:'Отменить снимок',exact:true}).tap();
    assert.equal(await page.locator('.overlay').count(),0);
    assert.deepEqual(await page.evaluate(()=>({scrollY,scale:visualViewport.scale})),before);
    await enter(page);
    assert.deepEqual(await pixel(page,100,200),[40,150,80,255]);
    await page.getByRole('button',{name:'Продолжить без снимка',exact:true}).tap();
    await mobileForm(page);
    await page.getByRole('button',{name:'Отмена',exact:true}).tap();
    assert.deepEqual(await page.evaluate(()=>({scrollY,scale:visualViewport.scale})),before);
    await enter(page);
  });
  await t.test('auth stays visible with16px fields and invalidates the pre-login scroll snapshot', async scope => {
    const response = await fetch(kitBase+'/api/reporter/register',{method:'POST',headers:{Origin:origin,'X-Project-Key':'webkit-auth','Content-Type':'application/json'},body:JSON.stringify({name:'WebKit fixture',pin:'1234'})});
    assert.equal(response.status,201);
    const page = await pageFor(scope,'/auth');
    await page.getByRole('button',{name:'Сообщить о баге',exact:true}).tap();
    const auth=page.locator('.auth-card'); await auth.waitFor();
    assert.ok(await auth.locator('input').evaluateAll(els=>els.every(el=>parseFloat(getComputedStyle(el).fontSize)>=16)));
    assert.equal(await page.evaluate(()=>document.activeElement.tagName),'BODY');
    const rect=await auth.boundingBox();assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=391&&rect.y+rect.height<=700);
    await auth.locator('input[type=text]').fill('WebKit fixture');
    await auth.locator('input[type=password]').fill('1234');
    await page.evaluate(()=>scrollTo(0,650));
    await page.getByRole('button',{name:'Войти',exact:true}).tap();
    await page.locator('.overlay:not(.is-preparing)').waitFor();
    assert.equal(await page.evaluate(()=>scrollY),650);
    assert.deepEqual(await pixel(page,100,400),[40,150,80,255],'capture must be refreshed after scroll during login');
    await page.getByRole('button',{name:'Продолжить без снимка',exact:true}).tap();
    await mobileForm(page);
  });
});
