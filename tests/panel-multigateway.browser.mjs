import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {createServer,request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';
import {createApp} from '../server/app.mjs';

test('two project panels use the same UI while showing only their own reports', async t => {
  const dir=mkdtempSync(join(tmpdir(),'kit-multigateway-browser-'));
  const ids=['one','two'], appOrigin='http://localhost:7338';
  const panelGateways=ids.map(id=>({mountPath:`/projects/${id}/bugs/`,signInPath:`/projects/open/${id}`,
                                   logoutPath:'/projects/logout',preserveLegacy:true}));
  const projects=ids.map(id=>({id,name:`Project ${id}`,widgetKey:`key-${id}`,
    allowedOrigins:[appOrigin],reporterAuth:true,panelAccess:true,panelAccountIds:[]}));
  const teamTokens=ids.map(id=>({name:`Reviewer ${id}`,token:`private-${id}`,role:'reviewer',projects:[id]}));
  const app=createApp({projects,panelGateways,teamTokens,reporterAuthSecret:'synthetic-reporter-secret-32-plus'},
                      {database:join(dir,'reports.sqlite')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const backend=`http://127.0.0.1:${app.server.address().port}`;
  const proxy=createServer((req,res)=>{
    const match=req.url.match(/^\/projects\/(one|two)\/bugs\/(.*)$/);
    let path=req.url; const headers={...req.headers}; delete headers.authorization; delete headers.cookie;
    if(match){
      if(req.headers.cookie!=='hub=fixture'){res.writeHead(401);return res.end();}
      if(match[2].startsWith('api/')){path='/'+match[2];headers.authorization=`Bearer private-${match[1]}`;}
    }
    const upstream=request(backend+path,{method:req.method,headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
    req.pipe(upstream);
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>proxy.close(resolve));await new Promise(resolve=>app.server.close(resolve));app.db.close();rmSync(dir,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${proxy.address().port}`;
  for(const id of ids){
    const headers={Origin:appOrigin,'X-Project-Key':`key-${id}`,'Content-Type':'application/json'};
    const signup=await fetch(backend+'/api/reporter/register',{method:'POST',headers,body:JSON.stringify({name:`Reporter ${id}`,pin:'1234'})});
    assert.equal(signup.status,201);const {token}=await signup.json();
    const result=await fetch(backend+'/api/reports',{method:'POST',headers:{...headers,'X-Reporter-Token':token},
      body:JSON.stringify({description:`Report ${id}`,pageUrl:appOrigin+'/page'})});
    assert.equal(result.status,201);
  }
  const browser=await chromium.launch();t.after(()=>browser.close());
  const context=await browser.newContext();await context.addCookies([{name:'hub',value:'fixture',domain:'127.0.0.1',path:'/projects/',httpOnly:true}]);
  const page=await context.newPage();
  for(const [id,other] of [['one','two'],['two','one']]){
    await page.goto(`${origin}/projects/${id}/bugs/`);
    await page.getByRole('button',{name:new RegExp(`Report ${id}`)}).waitFor();
    assert.equal(await page.getByRole('button',{name:new RegExp(`Report ${other}`)}).count(),0);
    assert.equal(await page.locator('#actor').textContent(),`Reviewer ${id}`);
    assert.equal(await page.getByLabel('PIN',{exact:true}).count(),0);
  }
});
