import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SCOPES,missingGoogleScopes} from '../supabase/functions/google-connect/scopes.ts';
const reporting='https://www.googleapis.com/auth/analytics.readonly';
test('consent requests reporting access and old Admin-only grants stay partial',()=>{
 assert.ok(SCOPES.includes(reporting));
 assert.deepEqual(missingGoogleScopes(SCOPES.filter(s=>s!==reporting)),[reporting]);
 assert.deepEqual(missingGoogleScopes(SCOPES),[]);
});
test('broader existing Analytics consent covers reporting, without accepting unrelated partial grants',()=>{
 assert.deepEqual(missingGoogleScopes([...SCOPES.filter(s=>s!==reporting),'https://www.googleapis.com/auth/analytics']),[]);
 assert.ok(missingGoogleScopes([reporting]).includes('https://www.googleapis.com/auth/business.manage'));
 assert.ok(missingGoogleScopes([]).includes(reporting));
});
