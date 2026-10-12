import {test} from "node:test";
import {readFileSync,readdirSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";
import {pgcrypto} from "@electric-sql/pglite/contrib/pgcrypto";
import {uuid_ossp} from "@electric-sql/pglite/contrib/uuid_ossp";

test("growth and backlink client isolation, evidence, ownership and grants after full migration replay",async()=>{
 const db=new PGlite({extensions:{pgcrypto,uuid_ossp}});
 try {
  await db.exec("create role supabase_admin superuser login");
  await db.exec(readFileSync("supabase/tests/sandbox/bootstrap.sql","utf8").replace("create role postgres login nosuperuser bypassrls createrole createdb;","").replaceAll("database sandbox","database postgres"));
  await db.exec("set session authorization postgres; set search_path=public,extensions");
  for(const file of readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).sort()) {
   const sql=readFileSync(`supabase/migrations/${file}`,"utf8").replace(/^create extension if not exists pg_(cron|net);/mg,"");
   await db.exec(`begin;${sql};commit;`);
  }
  await db.exec(readFileSync("supabase/tests/sandbox/fixtures.sql","utf8"));
  await db.exec(readFileSync("supabase/tests/sandbox/client_growth.test.sql","utf8"));
  await db.exec(readFileSync("supabase/tests/sandbox/growth_rankings.test.sql","utf8"));
  await db.exec(readFileSync("supabase/tests/sandbox/gbp_performance.test.sql","utf8"));
  await db.exec(readFileSync("supabase/tests/sandbox/dashboard_reporting.test.sql","utf8"));
 }finally{await db.close();}
});
