import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
const clientId='00000000-0000-4000-8000-000000000001',teamId='00000000-0000-4000-8000-000000000011';
const kw='00000000-0000-4000-8000-000000000021',kw2='00000000-0000-4000-8000-000000000022';
const config={target_place_id:'ChIJfixture',zoom:13,points:Array.from({length:25},(_,i)=>({lat:38.8+Math.floor(i/5)*.025,lng:-90.9+(i%5)*.03})),keywords:[{id:kw,keyword:'roof repair'},{id:kw2,keyword:'roof replacement'}]};
const profile={...config,id:'profile',client_id:clientId,grid_config_id:'grid',label:'Fictional pilot',enabled:true,weekly_enabled:false};
const runs=[{id:'run',profile_id:'profile',started_at:'2026-10-15T01:00:00Z',status:'complete',config,error:null}];
const checks=config.keywords.flatMap(k=>config.points.map((p,i)=>({...p,id:`${k.id}-${i}`,keyword_id:k.id,keyword:k.keyword,point_index:i,state:i===24?'failed':'complete',position:i===23?null:(i%12)+1,results:[{place_id:'ChIJfixture',position:(i%12)+1,title:'Fixture Roofing',domain:'example.test'}],cost:.0006,error:null,checked_at:'2026-10-15T01:01:00Z'})));
const baseline=config.keywords.map(k=>({keyword_id:k.id,recorded_at:'2026-09-24T14:00:00Z',points:config.points.map(p=>({...p,position:2}))}));
const unexpected=[];let starts=0;
const user={id:teamId,email:'fixture@example.test',aud:'authenticated',role:'authenticated'};
const upstream=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');const reply=(v,s=200)=>{res.writeHead(s,{'content-type':'application/json'});res.end(JSON.stringify(v));};
 let body='';for await(const c of req)body+=c;
 if(url.pathname==='/auth/v1/user')return reply(user);
 if(url.pathname==='/rest/v1/team_members')return reply([{id:teamId}]);
 if(url.pathname==='/rest/v1/rpc/is_team')return reply(true);
 if(url.pathname==='/rest/v1/clients')return reply({id:clientId,name:'Fictional grid client',status:'active',website_url:'https://example.test'});
 if(url.pathname==='/rest/v1/map_grid_profiles')return reply([profile]);
 if(url.pathname==='/rest/v1/map_grid_runs')return reply(runs);
 if(url.pathname==='/rest/v1/map_grid_checks')return reply(checks);
 if(url.pathname==='/rest/v1/grid_snapshots')return reply(baseline);
 if(url.pathname==='/functions/v1/map-grid-sync'){starts++;assert.equal(JSON.parse(body).profile_id,'profile');return reply({error:'Wait one hour before another scan'},503);}
 unexpected.push(url.pathname);return reply({error:'Unexpected fixture request'},500);
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const port=3449,shots='docs/screenshots/map-grid';mkdirSync(shots,{recursive:true});
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'fixture-key',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
let logs='',browser;app.stdout.on('data',c=>logs=(logs+c).slice(-6000));app.stderr.on('data',c=>logs=(logs+c).slice(-6000));
try{
 for(let i=0;i<120;i++){if(app.exitCode!==null)throw Error(logs);try{await fetch(`http://127.0.0.1:${port}/login`);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const executable=process.env.CHROME_PATH??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
 browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),part=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),exp=Math.floor(Date.now()/1000)+3600;
 await context.addCookies([{name:'sb-127-auth-token',value:`base64-${part({access_token:`${part({alg:'HS256'})}.${part({sub:teamId,exp})}.fixture`,refresh_token:'fixture',expires_at:exp,expires_in:3600,token_type:'bearer',user})}`,domain:'127.0.0.1',path:'/'}]);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/maps`,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'Your rankings, across the map.'}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Your rankings, across the map.'}).evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)');
 await page.locator('.leaflet-marker-icon').first().waitFor();assert.equal(await page.locator('.leaflet-marker-icon').count(),25);
 await page.locator('.leaflet-marker-icon').first().click();await page.getByRole('heading',{name:'Point 1',exact:true}).waitFor();assert.ok(await page.getByText('Fixture Roofing',{exact:true}).isVisible());
 await page.getByLabel('Map keyword').selectOption(kw2);assert.equal(await page.getByRole('heading',{name:'Explore a point'}).count(),1);
 await page.getByLabel('Grid source').selectOption('brightlocal');await page.getByText(/BrightLocal baseline: 2026-09-24/).waitFor();
 await page.getByLabel('Grid source').selectOption('dataforseo');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();assert.match((await download).suggestedFilename(),/^map-grid-dataforseo/);
 await page.getByRole('button',{name:'Run scan',exact:true}).click();await page.getByRole('alert').filter({hasText:'Wait one hour'}).waitFor();assert.equal(starts,1);
 await page.screenshot({path:`${shots}/desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${shots}/mobile.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('Grid browser checks passed: map points, competitors, keyword/source switching, baseline date, CSV, failed-start feedback, mobile layout.');
}catch(e){console.error(logs);throw e;}finally{await browser?.close();app.kill('SIGTERM');upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
