-- 004_roles.sql: the database user n8n connects as can call the agent's functions and nothing else. No table access,
-- so even a mistake in a workflow can't read or change data outside what the functions allow.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'shop_agent') then
    create role shop_agent nologin;  -- for a real server: create a login role and "grant shop_agent to <it>"
  end if;
end $$;

revoke all on all tables in schema shop from public, shop_agent;
revoke all on all functions in schema shop from public;
grant usage on schema shop to shop_agent;
grant execute on function
  shop.intake_record(text, text, text),
  shop.intake_claim(text, bigint),
  shop.intake_finish(text, uuid, text, bigint[], text, int, int, int, text),
  shop.run_tool(text, text, jsonb),
  shop.resume_bot(text)
to shop_agent;
