import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

// Execute the existing role-boundary SQL suites in embedded PostgreSQL when
// native server binaries are unavailable. Connection changes retain real
// session_user checks, and JWT roles still exercise grants and RLS.
function sqlFile(file) {
  let sql = readFileSync(file, 'utf8');
  const vars = {};
  sql = sql.replace(/^\\set\s+(\w+)\s+'([^']*)'.*$/gm, (_, k, v) => { vars[k] = v; return ''; });
  sql = sql.replace(/:'(\w+)'/g, (_, k) => `'${vars[k]}'`);
  sql = sql.replace(/^\\c\s+-\s+(\w+).*$/gm, (_, role) => `reset role; reset session authorization; reset all; set session authorization ${role};`);
  sql = sql.replace(/^\\(?:o|pset).*$/gm, '');
  return sql;
}
// psql commits each statement. Preserve that behavior, including local GUCs.
function statements(sql) {
 const out=[]; let start=0, quote=null, dollar=null, line=false, block=false;
 for(let i=0;i<sql.length;i++) {
  const c=sql[i], n=sql[i+1];
  if(line){if(c==='\n')line=false;continue;}
  if(block){if(c==='*'&&n==='/'){block=false;i++;}continue;}
  if(dollar){if(sql.startsWith(dollar,i)){i+=dollar.length-1;dollar=null;}continue;}
  if(quote){if(c===quote){if(n===quote)i++;else quote=null;}continue;}
  if(c==='-'&&n==='-'){line=true;i++;continue;}
  if(c==='/'&&n==='*'){block=true;i++;continue;}
  if(c==="'"||c==='"'){quote=c;continue;}
  if(c==='$'){const m=sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/);if(m){dollar=m[0];i+=dollar.length-1;continue;}}
  if(c===';'){out.push(sql.slice(start,i+1));start=i+1;}
 }
 if(sql.slice(start).trim())out.push(sql.slice(start));return out;
}
test('GBP migration, client ownership, approval invalidation and legacy review boundaries', async () => {
 const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
 try {
  await db.exec('create role supabase_admin superuser login; set session authorization supabase_admin; alter role postgres rename to pglite_bootstrap;');
  await db.exec(readFileSync('supabase/tests/sandbox/bootstrap.sql','utf8').replaceAll('database sandbox','database postgres'));
  await db.exec('set session authorization postgres; set search_path=public,extensions');
  for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) {
   await db.exec('begin;'+readFileSync('supabase/migrations/'+f,'utf8').replace(/^create extension if not exists pg_(cron|net);/gm,'')+';commit;');
  }
  for(const f of ['fixtures.sql','social_post_review.test.sql','drafter.test.sql','drafter_facebook.test.sql','zernio_gbp.test.sql','drafter_gbp_destination.test.sql','explicit_gbp_destinations.test.sql']) {
   await db.exec('reset role; reset session authorization; set session authorization postgres;');
   try { for (const statement of statements(sqlFile('supabase/tests/sandbox/'+f))) await db.exec(statement); }
   catch(e) { console.error('SQL suite failed:',f); for(const schema of ['zg','gd','fd']) { try {console.error((await db.query(`select * from ${schema}.results`)).rows.filter(r=>r.status==='fail'||r.passed===false));}catch{} } throw new Error(`${f}: ${e.message}`, {cause: {code:e.code,where:e.where}}); }
  }
 } finally { await db.close(); }
});
