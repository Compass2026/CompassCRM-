import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {localGrid,distanceMiles} from '../supabase/functions/_shared/map-grid.ts';
import {isoWeekStart,WEEKLY_SLOT_MS} from '../src/lib/map-grid-weekly.ts';
const clientId='00000000-0000-4000-8000-000000000001',teamId='00000000-0000-4000-8000-000000000011';
const kw='00000000-0000-4000-8000-000000000021',kw2='00000000-0000-4000-8000-000000000022';
const center={lat:38.805,lng:-90.815},keywords=[{id:kw,keyword:'roof repair'},{id:kw2,keyword:'roof replacement'}];
const dense=localGrid(center);
const config={target_place_id:'ChIJfixture',zoom:13,search_this_area:false,points:dense.points,geometry:dense.geometry,keywords};
// The earlier broad layout: 25 points ten miles apart, frozen before geometry existed.
const broad={target_place_id:'ChIJfixture',zoom:13,points:Array.from({length:25},(_,i)=>({lat:38.805+(Math.floor(i/5)-2)*.1449,lng:-90.815+((i%5)-2)*.1859})),keywords};
const profile={...config,id:'profile',client_id:clientId,grid_config_id:'grid',label:'Fictional pilot',enabled:true,weekly_enabled:false};
const runs=[{id:'dense',profile_id:'profile',started_at:'2026-10-16T01:00:00Z',status:'running',config,error:null},{id:'broad',profile_id:'profile',started_at:'2026-10-15T01:00:00Z',status:'complete',config:broad,error:null}];
const wichita={lat:37.6922361,lng:-97.3375448},marketGrid=localGrid(wichita,undefined,{label:'Wichita, KS market center'});
const market={target_place_id:'ChIJfixture',zoom:13,search_this_area:false,points:marketGrid.points,geometry:marketGrid.geometry,keywords};
const profile2={...market,id:'profile2',client_id:clientId,grid_config_id:'grid2',label:'Fictional pilot — Wichita, KS',enabled:true,weekly_enabled:true};
// Another client's run (profile 'other'): never reachable under this client.
const attempts=[{profile_id:'profile2',outcome:'error',message:'Grid keyword mismatch',attempted_at:new Date().toISOString(),run_id:null}];
const scanned=[];
// The Wichita grid's weekly scan, placed in the week the production rule checks
// (src/lib/map-grid-weekly.ts): this week once Thursday's 14:00 UTC slot has
// passed, last week before it. A minute after that week's slot, so never in the future.
const nowMs=Date.now(),thisWeek=isoWeekStart(nowMs),targetWeek=nowMs<thisWeek+WEEKLY_SLOT_MS?thisWeek-7*86400000:thisWeek;
const marketAt=new Date(targetWeek+WEEKLY_SLOT_MS+60000).toISOString().replace(/\.\d{3}Z$/,'Z');
const marketLabel=`${marketAt.slice(0,10)} ${marketAt.slice(11,16)} UTC · complete · dense 1/2/5 mi`;
runs.push({id:'market',profile_id:'profile2',started_at:marketAt,status:'complete',config:market,error:null},{id:'o1',profile_id:'other',started_at:'2026-10-14T01:00:00Z',status:'complete',config,error:null});
const make=(cfg,pending,c=center)=>cfg.keywords.flatMap(k=>cfg.points.map((p,i)=>{const d=distanceMiles(c,p),queued=pending&&i%17===5;return{...p,id:`${k.id}-${i}`,keyword_id:k.id,keyword:k.keyword,point_index:i,state:queued?'queued':'complete',position:queued?null:d>4.5&&i%3===0?null:1+Math.floor(d*2),results:queued?null:[{place_id:'ChIJfixture',position:1+Math.floor(d*2),title:'Fixture Roofing',domain:'example.test'}],cost:.0006,error:null,checked_at:'2026-10-16T01:01:00Z'};}));
const checks={dense:make(config,true),broad:make(broad,false),market:make(market,false,wichita)};
const baseline=keywords.map(k=>({grid_config_id:'grid',keyword_id:k.id,recorded_at:'2026-09-24T14:00:00Z',points:broad.points.map(p=>({...p,position:2}))}));
const unexpected=[];let starts=0;
const user={id:teamId,email:'fixture@example.test',aud:'authenticated',role:'authenticated'};
const upstream=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');const reply=(v,s=200)=>{res.writeHead(s,{'content-type':'application/json'});res.end(JSON.stringify(v));};
 let body='';for await(const c of req)body+=c;
 if(url.pathname==='/auth/v1/user')return reply(user);
 if(url.pathname==='/rest/v1/team_members')return reply([{id:teamId}]);
 if(url.pathname==='/rest/v1/rpc/is_team')return reply(true);
 if(url.pathname==='/rest/v1/clients')return reply({id:clientId,name:'Fictional grid client',status:'active',website_url:'https://example.test'});
 if(url.pathname==='/rest/v1/map_grid_profiles'){const id=url.searchParams.get('id');return reply(url.searchParams.get('client_id')==='eq.'+clientId?[profile,profile2].filter(p=>!id||'eq.'+p.id===id):[]);}
 if(url.pathname==='/rest/v1/map_grid_runs')return reply(runs.filter(r=>[...url.searchParams].every(([k,v])=>!v.startsWith('eq.')||'eq.'+r[k]===v)));
 if(url.pathname==='/rest/v1/map_grid_checks')return reply(checks[url.searchParams.get('run_id')?.replace('eq.','')]??[]);
 if(url.pathname==='/rest/v1/grid_snapshots')return reply(baseline.filter(b=>'eq.'+b.grid_config_id===url.searchParams.get('grid_config_id')));
 if(url.pathname==='/rest/v1/map_grid_weekly_attempts')return reply(attempts.filter(a=>'eq.'+a.profile_id===url.searchParams.get('profile_id')));
 if(url.pathname==='/rest/v1/grid_configs')return reply([{center_lat:center.lat,center_lng:center.lng}]);
 if(url.pathname==='/functions/v1/map-grid-sync'){starts++;scanned.push(JSON.parse(body).profile_id);return reply({error:'Wait one hour before another scan'},503);}
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
 const markers=page.locator('.leaflet-marker-pane .leaflet-marker-icon[title^="Point "]'),map=page.getByTestId('map-grid-map');
 const radius=label=>page.getByRole('group',{name:'Radius from business'}).getByRole('button',{name:new RegExp(`^${label}`)});
 const card=label=>page.locator('div.rounded-2xl',{has:page.getByText(label,{exact:true})}).first();
 const count=async n=>{try{await page.waitForFunction(n=>document.querySelectorAll('.leaflet-marker-pane .leaflet-marker-icon[title^="Point "]').length===n,n);}catch(e){const seen=await page.evaluate(()=>({markers:document.querySelectorAll('.leaflet-marker-pane .leaflet-marker-icon[title^="Point "]').length,maps:document.querySelectorAll('[data-testid=map-grid-map]').length,url:location.href,radius:[...document.querySelectorAll('[role=group] button[aria-pressed=true]')].map(b=>b.textContent)}));throw Error(`expected ${n} markers, saw ${JSON.stringify(seen)}: ${e.message}`);}};
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/maps`,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'Your rankings, across the map.'}).waitFor();
 // Dense scan opens at the 5-mile default with the business center and three rings.
 assert.equal(await radius('5 mi').getAttribute('aria-pressed'),'true');
 await count(153);
 assert.equal(await page.getByTestId('business-center').count(),1);
 assert.equal(await page.getByTestId('ring-label').count(),3);
 assert.match(await card('Sampled points').innerText(),/153[\s\S]*Within 5 mi/);
 // Pending checks are labelled as pending, not as losses, and excluded from coverage.
 assert.match(await card('Checks completed').innerText(),/\d+ pending or unavailable/);
 await page.screenshot({path:`${shots}/dense-5mi.png`,fullPage:true});
 for(const [label,n] of [['1 mi',49],['2 mi',85],['Full scan',153],['1 mi',49]]){await radius(label).click();await count(n);assert.equal(await radius(label).getAttribute('aria-pressed'),'true');assert.match(await card('Sampled points').innerText(),new RegExp(`^Sampled points\\s+${n}`));}
 // Fitting the 1-mile view zooms well past the old zoom-13 cap, and markers carry readable numbers.
 const fitted=Number(await map.getAttribute('data-zoom'));assert.ok(fitted>=14,`1-mile zoom ${fitted}`);
 assert.ok((await markers.first().innerText()).trim().length>0);
 await page.screenshot({path:`${shots}/dense-1mi.png`,fullPage:true});
 // Manual zoom/pan survives routine refreshes, resizes and keyword switches.
 await page.locator('.leaflet-control-zoom-in').click();await page.waitForFunction(z=>Number(document.querySelector('[data-testid=map-grid-map]').dataset.zoom)>z,fitted);
 const box=await map.boundingBox(),fittedCenter=await map.getAttribute('data-center');
 // Pan away from the fitted center and let drag inertia finish (moveend fires once it stops).
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+120,box.y+box.height/2+60,{steps:8});await page.mouse.up();
 await page.waitForFunction(c=>document.querySelector('[data-testid=map-grid-map]').dataset.center!==c,fittedCenter);await page.waitForTimeout(1500);
 const view=[await map.getAttribute('data-zoom'),await map.getAttribute('data-center')];
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForLoadState('networkidle');await page.waitForTimeout(800);
 await page.setViewportSize({width:1300,height:1000});await page.waitForTimeout(500);
 await page.getByLabel('Map keyword').selectOption(kw2);await count(49);
 assert.deepEqual([await map.getAttribute('data-zoom'),await map.getAttribute('data-center')],view);
 await page.setViewportSize({width:1440,height:1000});
 await radius('2 mi').click();await count(85);await page.waitForTimeout(300);
 await page.getByLabel('Distance rings').uncheck();await page.waitForFunction(()=>!document.querySelector('[data-testid=ring-label]'));await page.getByLabel('Distance rings').check();await page.getByTestId('ring-label').nth(2).waitFor();
 await page.screenshot({path:`${shots}/dense-2mi.png`,fullPage:true});
 // A marker reports its distance from the business.
 await markers.first().click();await page.getByText(/mi from the business/).waitFor();
 // None of the radius, zoom, pan, ring or keyword changes asked for a scan.
 assert.equal(starts,0);
 // Straight from the dense run to the BrightLocal baseline: the controls, counts, header and
 // warning describe the baseline's own 25 broad points, never the dense scan's metadata.
 const radiusCounts=async()=>Promise.all(['1 mi','2 mi','5 mi','Full scan'].map(async l=>Number((await radius(l).innerText()).match(/\((\d+)\)/)[1])));
 const zoomBelow=z=>page.waitForFunction(z=>Number(document.querySelector('[data-testid=map-grid-map]').dataset.zoom)<z,z);
 await radius('Full scan').click();await count(153);await page.waitForTimeout(300);
 const denseFull=Number(await map.getAttribute('data-zoom'));
 // Zoom in by hand so the refit on the source switch is observable.
 await page.locator('.leaflet-control-zoom-in').click();await page.waitForFunction(z=>Number(document.querySelector('[data-testid=map-grid-map]').dataset.zoom)>z,denseFull);
 await page.getByLabel('Grid source').selectOption('brightlocal');await count(25);
 assert.equal(await radius('Full scan').getAttribute('aria-pressed'),'true');
 // Same radius (full) and center as before, yet the view refits to the wider baseline extent.
 await zoomBelow(denseFull);
 assert.deepEqual(await radiusCounts(),[1,1,1,25]);
 await page.getByText(/BrightLocal baseline · 25 points · 2 keywords/).waitFor();
 assert.equal(await page.getByText(/Dense local scan/).count(),0);
 await page.getByRole('note').filter({hasText:'This BrightLocal baseline has no dense 1/2/5-mile layout: 25 points, about 10 mi apart.'}).waitFor();
 for(const [label,n] of [['1 mi',1],['2 mi',1],['5 mi',1],['Full scan',25]]){
  await radius(label).click();await count(n);
  assert.equal(await markers.count(),(await radiusCounts())[['1 mi','2 mi','5 mi','Full scan'].indexOf(label)]);
  assert.match(await card('Sampled points').innerText(),new RegExp(`^Sampled points\\s+${n}`));
  const note=await page.getByRole('note').innerText();
  assert.match(note,/25 points, about 10 mi apart/);
  if(label!=='Full scan')assert.match(note,new RegExp(`Only 1 sampled point falls within ${label}`));else assert.doesNotMatch(note,/Only/);
  if(label==='5 mi')await page.screenshot({path:`${shots}/brightlocal-from-dense-5mi.png`,fullPage:true});
 }
 await page.screenshot({path:`${shots}/brightlocal-from-dense-full.png`,fullPage:true});
 // Back to DataForSEO: the dense run's own default, counts and no broad warning.
 await page.getByLabel('Grid source').selectOption('dataforseo');await count(153);
 assert.equal(await radius('5 mi').getAttribute('aria-pressed'),'true');
 assert.deepEqual(await radiusCounts(),[49,85,153,153]);
 assert.equal(await page.getByRole('note').count(),0);
 await page.getByText(/Dense local scan, 1 \/ 2 \/ 5 mi · 153 points/).waitFor();
 assert.equal(starts,0);
 // The old broad scan opens at its full extent and says what it cannot show.
 await page.getByLabel('Scan history').selectOption('broad');await page.waitForURL(/run=broad/);
 await page.getByText(/This scan has no dense 1\/2\/5-mile layout: 25 points, about 10 mi apart/).waitFor();
 assert.equal(await radius('Full scan').getAttribute('aria-pressed'),'true');await count(25);
 await radius('5 mi').click();await count(1);await page.getByText(/Only 1 sampled point falls within 5 mi/).waitFor();
 assert.equal(await page.getByTestId('business-center').count(),1);
 await page.screenshot({path:`${shots}/broad-5mi.png`,fullPage:true});
 await radius('Full scan').click();await count(25);
 await page.getByLabel('Grid source').selectOption('brightlocal');await page.getByText(/BrightLocal baseline: 2026-09-24/).waitFor();await page.getByText(/This BrightLocal baseline has no dense 1\/2\/5-mile layout/).waitFor();
 await page.screenshot({path:`${shots}/broad-full.png`,fullPage:true});
 await page.getByLabel('Grid source').selectOption('dataforseo');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();assert.match((await download).suggestedFilename(),/^map-grid-dataforseo-.*-full\.csv$/);
 assert.equal(starts,0);
 // Starting a scan needs an explicit confirmation that states points, checks and cost of the next scan.
 await page.getByRole('button',{name:'Run scan',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Confirm paid scan'});
 await dialog.getByText('Start a paid scan of 306 checks (est. $0.184)?').waitFor();
 assert.match(await dialog.innerText(),/49 points within 1 mi, 85 points within 2 mi, 153 points within 5 mi/);
 assert.match(await dialog.innerText(),/query-led location/);
 await page.screenshot({path:`${shots}/scan-preview.png`});
 await dialog.getByRole('button',{name:'Cancel'}).click();assert.equal(starts,0);
 await page.getByRole('button',{name:'Run scan',exact:true}).click();await dialog.getByRole('button',{name:'Start paid scan'}).click();
 await page.getByRole('alert').filter({hasText:'Wait one hour'}).waitFor();assert.equal(starts,1);
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/maps`,{waitUntil:'networkidle'});await count(153);
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);await page.screenshot({path:`${shots}/mobile.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 // A market-centered run (service-area business, no public address) measures from the scan center, never from the business.
 // Two profiles for one client: the location selector switches to Wichita without any scan request.
 await page.setViewportSize({width:1440,height:1000});
 const startsBeforeLocations=starts;
 assert.deepEqual(await page.getByLabel('Map location').locator('option').allTextContents(),['Fictional pilot','Fictional pilot — Wichita, KS']);
 await page.getByLabel('Map location').selectOption('profile2');await page.waitForURL(/profile=profile2/);
 assert.equal(await page.getByLabel('Map location').inputValue(),'profile2');
 assert.deepEqual(await page.getByLabel('Scan history').locator('option').allTextContents(),[marketLabel]);
 // Refresh keeps the selected location; the first profile's history is not mixed in.
 await page.reload({waitUntil:'networkidle'});assert.equal(await page.getByLabel('Map location').inputValue(),'profile2');
 assert.equal(starts,startsBeforeLocations);
 // The selected grid's own weekly notice: its complete scan this week, and the start error recorded for it.
 assert.equal(await page.locator('[data-weekly-scan-state]').getAttribute('data-weekly-scan-state'),'ok');
 assert.match(await page.locator('[data-weekly-scan-state]').textContent(),/Failed to start — Grid keyword mismatch/);
 // The Refresh button keeps the selection.
 await page.getByRole('button',{name:'Refresh'}).click();await page.waitForTimeout(800);
 assert.match(page.url(),/profile=profile2/);assert.equal(await page.getByLabel('Map location').inputValue(),'profile2');
 // An older ?run= link without ?profile= opens its run's own grid, not the first one.
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/maps?run=market`,{waitUntil:'networkidle'});
 assert.equal(await page.getByLabel('Map location').inputValue(),'profile2');
 // The first grid has no weekly notice: notices never leak across grids.
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/maps?profile=profile`,{waitUntil:'networkidle'});
 assert.equal(await page.locator('[data-weekly-scan-state]').count(),0);
 // Another client's grid or run is a 404 here too.
 for(const q of ['profile=other','run=o1','profile=profile&run=market']){const r=await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/maps?${q}`);assert.equal(r.status(),404,q);assert.doesNotMatch(await page.locator('body').innerText(),/Another client/);}
 assert.equal(starts,startsBeforeLocations);
 // A profile id that is not this client's is a 404, never another client's data.
 const foreign=await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/maps?profile=00000000-0000-4000-8000-0000000000ff`);assert.equal(foreign.status(),404);
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/maps?profile=profile2`,{waitUntil:'networkidle'});
 await page.getByTestId('market-center-note').filter({hasText:'This scan is centred on Wichita, KS market center, not on a business address'}).waitFor();
 const marketRadius=label=>page.getByRole('group',{name:'Radius from scan center'}).getByRole('button',{name:new RegExp(`^${label}`)});
 assert.equal(await marketRadius('5 mi').getAttribute('aria-pressed'),'true');await count(153);
 await page.getByText(/Dense local scan, 1 \/ 2 \/ 5 mi around Wichita, KS market center/).waitFor();
 assert.match(await card('Sampled points').innerText(),/Within 5 mi of the scan center/);
 await marketRadius('1 mi').click();await count(49);
 await markers.first().click();await page.getByText(/mi from the scan center/).waitFor();
 assert.equal(await page.locator('[title="Wichita, KS market center (scan center)"]').count()+await page.getByText('Wichita, KS market center',{exact:true}).count()>=1,true);
 const marketText=await page.locator('main').innerText();
 assert.doesNotMatch(marketText,/(of|from) the business/);
 assert.doesNotMatch(marketText,/Radius from business/);
 await page.screenshot({path:`${shots}/market-center-1mi.png`,fullPage:true});
 assert.equal(starts,1);
 // A scan started on the Wichita grid targets that grid only.
 await page.getByRole('button',{name:'Run scan',exact:true}).click();
 await page.getByRole('dialog',{name:'Confirm paid scan'}).getByRole('button',{name:'Start paid scan'}).click();
 await page.getByRole('alert').filter({hasText:'Wait one hour'}).waitFor();
 assert.deepEqual(scanned,['profile','profile2']);
 assert.equal(starts,2);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('Grid browser checks passed: two profiles for one client (location selector, reload and Refresh keep it, separate history, per-grid weekly notice, ?run= opens its own grid, other clients\' grid/run 404, scan targets the selected grid, no scan request on switching), market-centered run labelled from the scan center (never the business), 1/2/5-mile radius controls (49/85/153 points), dense run straight to BrightLocal (1/1/1/25, own warning, refit) and back, center and rings, zoom/pan kept through refresh/resize/keyword switch, pending and old broad scans, per-radius metrics, scan preview and confirmation, no scan request on view changes, CSV, mobile layout.');
}catch(e){console.error(logs);throw e;}finally{await browser?.close();app.kill('SIGTERM');upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
