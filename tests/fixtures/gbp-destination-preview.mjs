import assert from 'node:assert/strict';
export function fixture({clients,uid}) {
 const client=clients[0];client.name='Logic Solar (fictional preview)';client.home_city='Wichita';client.home_state='KS';
 const profile=(n,label)=>({id:uid(n),client_id:client.id,platform:'google_business',display_name:label,external_account_id:`locations/${n}`,publish_page_id:`locations/${n}`,publish_provider:'zernio',publish_verified_at:'2026-10-15T17:00:00Z',publish_account_id:'111111111111111111111111',publish_account_name:'Connected Google account',publish_enabled:false,publish_health:{status:'healthy'}});
 const post=(n,review,account)=>({id:uid(n),client_id:client.id,platform:'google_business',social_account_id:account,post_type:'standard',search_intent:'navigational',copy:'Fictional review preview. This is not marketing content and cannot be published.',review_status:review,publish_status:'not_scheduled',crm_facts_only:true,created_at:'2026-10-15T17:00:00Z',submitted_at:review==='in_review'?'2026-10-15T17:00:00Z':null,author_kind:'human',notes:null,creative_policy:'none',creative_status:'not_requested',publish_attempts:0});
 return {
  tables:{brand_assets:[],social_accounts:[profile(810,'Wichita • verified fixture'),profile(811,'Second verified market • fixture')],publisher_gbp_policies:[{client_id:client.id,require_explicit:true,excluded_locations:[]}],publisher_client_transports:[{client_id:client.id,gbp_transport:'zernio'}],social_posts:[post(820,'draft',null),post(821,'in_review',uid(810))]},
  pages:[['gbp-draft',`/clients/${client.id}/social/${uid(820)}`],['gbp-review',`/clients/${client.id}/social/${uid(821)}`]],
  rpc(fn,body) {
    if (fn === 'social_post_readiness') return body.p_post_id === uid(820) ? ['Choose an explicit verified Business Profile destination before review.'] : [];
  },
  async check(page,name) {
   if(name==='gbp-draft') {
    const select=page.getByLabel('Google Business Profile destination');
    assert.equal(await select.inputValue(),'');
    assert.equal(await select.locator('option').count(),3);
    await select.selectOption(uid(811));assert.equal(await select.inputValue(),uid(811));
    await select.selectOption(uid(810));
   } else {
    assert.match(await page.locator('[data-gbp-review-destination]').innerText(),/Wichita.*locations\/810/s);
    assert.equal(await page.locator('select[name=social_account_id]').count(),0,'review destination is frozen');
   }
   assert.ok(!/Austin|street address|walk-in office/i.test(await page.locator('[data-gbp-review-destination]').innerText()));
  }
 };
}
