// Supplemental local replay. The native PostgreSQL CI suite remains the release gate.
// PGlite keeps its initial postgres superuser; do not treat this as the full worker-role suite.
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
const root=new URL('..',import.meta.url).pathname.replace(/\/$/,'');
const req=createRequire(root+'/package.json');
const {PGlite}=req('@electric-sql/pglite');
const {pgcrypto}=req('@electric-sql/pglite/contrib/pgcrypto');
const {uuid_ossp}=req('@electric-sql/pglite/contrib/uuid_ossp');
const db=new PGlite({extensions:{pgcrypto,uuid_ossp}});
try {
 await db.exec('create role supabase_admin superuser login;');
 let boot=readFileSync(root+'/supabase/tests/sandbox/bootstrap.sql','utf8').replace('create role postgres login nosuperuser bypassrls createrole createdb;','').replaceAll('database sandbox','database postgres');
 await db.exec(boot);
 await db.exec('set session authorization postgres; set search_path=public,extensions;');
 for(const file of readdirSync(root+'/supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) {
  const sql=readFileSync(root+'/supabase/migrations/'+file,'utf8').replace(/^create extension if not exists pg_(cron|net);/mg,'');
  try {await db.exec('begin;'+sql+';commit;');console.log('applied',file);}catch(e){console.error('FAILED',file,e.message,e.detail,e.where);process.exitCode=1;break;}
 }
 if(!process.exitCode) {await db.exec('reset role;set session authorization supabase_admin;');console.log('REPLAY COMPLETE');
  await db.exec('reset role;reset session authorization;');
  await db.exec(readFileSync(root+'/supabase/tests/sandbox/fixtures.sql','utf8'));
  const vars={};
  async function psql(source) {
   let sql='';
   for(const line of source.split('\n')) {
    if(line.startsWith('\\')) {
     if(sql.trim()) await db.exec(sql); sql='';
     if(line.startsWith('\\c ')) {const role=line.trim().split(/\s+/).at(-1);await db.exec(`reset role;reset session authorization;set session authorization ${role};set search_path=public,extensions;`);}
     if(line.startsWith('\\set ')) {const m=line.match(/^\\set\s+(\w+)\s+'([^']+)'/);if(m)vars[m[1]]=m[2];}
    } else sql+=line.replace(/:'(\w+)'/g,(_,key)=>`'${vars[key]}'`)+'\n';
   }
   if(sql.trim()) await db.exec(sql);
  }
  await psql(readFileSync(root+'/supabase/tests/sandbox/content_drafts.test.sql','utf8').split('-- ── Fixtures')[0]);
  await psql(readFileSync(root+'/supabase/tests/sandbox/brand_workspaces.test.sql','utf8'));
  await db.exec('reset role;reset session authorization;');
  console.log(JSON.stringify((await db.query('select name,status,detail from cd.results')).rows));}
} catch(e){console.error('BOOT',e.message);process.exitCode=1;} finally {await db.close();}

