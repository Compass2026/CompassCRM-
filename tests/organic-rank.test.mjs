import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {urlHost,siteHosts,organicRankState} from '../src/lib/organic-rank.ts';

// The SQL migration asserts the same cases in its verify block.
const cases=[
 ['dataforseo',3,'https://www.site.test/a',['site.test'],'website'],
 ['dataforseo',3,'https://blog.site.test/a',['site.test'],'website'],
 ['dataforseo',1,'https://www.facebook.com/site',['site.test'],'third_party'],
 ['dataforseo',1,'https://site.test.evil.test/',['site.test'],'third_party'],
 ['dataforseo',1,'https://notsite.test/',['site.test'],'third_party'],
 ['dataforseo',2,null,['site.test'],'unverified'],
 ['dataforseo',2,'https://site.test/',[],'unverified'],
 ['brightlocal_report',2,null,['site.test'],'website'],
 ['dataforseo',null,null,['site.test'],'not_found'],
];
test('organic rank state matches the SQL truth table',()=>{
 for(const [source,position,url,hosts,expected] of cases) assert.equal(organicRankState(source,position,url,hosts),expected,`${source} ${position} ${url}`);
 const sql=readFileSync('supabase/migrations/20261020230000_organic_rank_website_only.sql','utf8');
 for(const [source,position,url,hosts,expected] of cases.filter(c=>c[3].length)){
  const call=`public.organic_rank_state('${source}', ${position??'null'}, ${url?`'${url}'`:'null'}, array['${hosts[0]}']) <> '${expected}'`;
  assert.ok(sql.includes(call),`SQL verify block covers: ${call}`);
 }
});
test('hosts: scheme, credentials, port, www and case are normalised; junk is no host',()=>{
 assert.equal(urlHost('HTTPS://User:pw@WWW.Site.Test:8443/x?y#z'),'site.test');
 assert.equal(urlHost('site.test/no-scheme'),null);
 assert.equal(urlHost(null),null);
 assert.deepEqual(siteHosts(['https://site.test','https://www.site.test/','https://brand.test',null,'bad']),['site.test','brand.test']);
});
