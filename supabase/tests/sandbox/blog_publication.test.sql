-- Uses the fictional approved draft produced by content_drafts.test.sql.
\c - supabase_admin
insert into sites (client_id,url,stack,controlled_by_compass,repo_url,branch,content_adapter,content_paths)
values(cd.id('a'),'https://draft.example.test','nextjs',true,'https://github.com/example/draft','main','lucas_json',
  '{"blog":"data/blog-posts.json","blog_route":"/blog/{slug}"}');
\c - authenticator
set role authenticated;
select cd.as_user('authenticated','00000000-0000-4000-a000-000000000001');
do $$
declare d content_drafts; p uuid; q uuid; e text;
begin
  select * into d from content_drafts where id=cd.get('blog')::uuid;
  perform cd.ok('PUB1 changed website destination needs re-review',
    cd.try(format('select blog_publication_queue(%L,%s)',d.id,d.version)) like '23514%');
  update content_drafts set status='draft' where id=d.id;
  update content_drafts set status='in_review' where id=d.id;
  perform content_draft_approve(d.id,d.version);
  p := blog_publication_queue(d.id,d.version,now()+interval '1 hour');
  q := blog_publication_queue(d.id,d.version,now()+interval '1 hour');
  perform cd.ok('PUB2 queue retry creates one immutable release',p=q and
    (select snapshot->>'body_markdown'=d.body_markdown and released_by is not null and status='queued'
      from blog_publications where id=p));
  perform cd.ok('PUB3 a queued release cannot be silently reopened or retargeted',
    cd.try(format('update content_drafts set status=''draft'' where id=%L',d.id)) like '23514%');
  perform cd.ok('PUB4 direct publication mutation and worker-only APIs are refused',
    cd.try(format('update blog_publications set status=''published'' where id=%L',p)) like '42501%'
    and cd.try(format('select blog_publication_claim(%L)',p)) like '42501%');
  perform blog_publication_cancel(p);
  update content_drafts set status='draft' where id=d.id;
  perform cd.ok('PUB5a approval history survives reopening',
    (select count(*) from content_draft_reviews where draft_id=d.id)>=2);
  perform cd.ok('PUB5 cancelling releases the draft for editing and preserves history',
    (select status='cancelled' and snapshot->>'body_markdown'=d.body_markdown from blog_publications where id=p));
end $$;
reset role;
\c - postgres
select set_config('compass.blog_publication_write','on',false);
select cd.ok('PUB6 a forged worker flag cannot mutate release history',
  cd.try('update blog_publications set last_error=''forged''') like '42501%');
select set_config('compass.blog_publication_write','',false);
\c - authenticator
set role authenticated;
select cd.as_user('authenticated','00000000-0000-4000-a000-000000000011');
select cd.ok('PUB7 portal cannot see or queue blog releases',
  (select count(*) from blog_publications)=0 and
  cd.try(format('select blog_publication_queue(%L,1)',cd.get('blog'))) like '42501%');
reset role;
\c - postgres
select n,status,name,detail from cd.results where status<>'pass';
do $$ begin if exists(select 1 from cd.results where status='fail') then raise exception 'Blog publication checks failed'; end if; end $$;
