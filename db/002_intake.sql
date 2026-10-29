-- 002_intake.sql: getting from "a message arrived" to "exactly one agent turn runs for this conversation".
--   1. intake_record  store the message, ignore duplicates (channels retry webhooks)
--   2. (n8n waits a few seconds so a burst of short messages becomes one turn)
--   3. intake_claim   only the newest message's run continues, and only if it gets the conversation's lease
--   4. intake_finish  save the reply, mark the messages done, release the lease, say if more arrived meanwhile

-- 1. Returns the new message id, or null when this channel message was already recorded.
create or replace function shop.intake_record(p_conv text, p_external_id text, p_text text) returns bigint
language plpgsql security definer set search_path = shop, pg_temp as $$
declare v_id bigint;
begin
  if coalesce(trim(p_conv), '') = '' or coalesce(trim(p_external_id), '') = '' then
    raise exception 'conversation id and message id are required';
  end if;
  insert into conversations (id) values (p_conv) on conflict (id) do nothing;
  insert into messages (conversation_id, external_id, role, content)
  values (p_conv, p_external_id, 'customer', left(coalesce(p_text, ''), 4000))
  on conflict (conversation_id, external_id) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- Context the model gets with every turn. Only what the prompt needs; no internal ids.
create or replace function shop.turn_context(p_conv text) returns jsonb
language sql stable security definer set search_path = shop, pg_temp as $$
  select jsonb_build_object(
    'store_name', setting('store_name'),
    'return_window_days', setting('return_window_days'),
    'today', to_char(now(), 'YYYY-MM-DD'),
    'customer', (select jsonb_build_object('name', cu.name, 'identified', true)
                   from conversations c join customers cu on cu.id = c.customer_id where c.id = p_conv)
  )
$$;

-- 3. p_msg = the message this run was started for (null = the newest pending one). Returns null when this run
-- should stop: a newer message will start its own run, a human has taken over, or another run holds the lease.
create or replace function shop.intake_claim(p_conv text, p_msg bigint) returns jsonb
language plpgsql security definer set search_path = shop, pg_temp as $$
declare
  v_latest bigint;
  v_mode   text;
  v_token  uuid;
begin
  select max(id) into v_latest from messages
   where conversation_id = p_conv and role = 'customer' and processed_at is null;
  if v_latest is null or (p_msg is not null and v_latest <> p_msg) then
    return null;
  end if;

  select mode into v_mode from conversations where id = p_conv;
  if v_mode = 'human' then
    -- staff are handling it: leave the messages for them, but don't start turns for them again
    update messages set processed_at = now() where conversation_id = p_conv and processed_at is null and role = 'customer';
    return null;
  end if;

  update conversations
     set lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => (setting('lease_seconds'))::int)
   where id = p_conv and (lease_until is null or lease_until < now())
  returning lease_token into v_token;
  if v_token is null then
    return null;  -- another run is mid-turn; intake_finish will report the pending message
  end if;

  return jsonb_build_object(
    'conversation_id', p_conv,
    'token', v_token,
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'text', content) order by id), '[]')
                   from messages where conversation_id = p_conv and role = 'customer' and processed_at is null),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('role', role, 'text', content) order by id), '[]')
                  from (select id, role, content from messages
                         where conversation_id = p_conv and processed_at is not null and role in ('customer', 'assistant')
                         order by id desc limit (setting('history_messages'))::int) h),
    'context', turn_context(p_conv)
  );
end $$;

-- 4. Saves the turn. Raises if the lease was lost (expired and taken by another run), so a slow run can never
-- overwrite a newer one. Returns { pending, next_msg } when customer messages arrived during the turn.
create or replace function shop.intake_finish(p_conv text, p_token uuid, p_reply text, p_msg_ids bigint[],
                                              p_model text, p_input int, p_output int, p_steps int, p_handoff text)
returns jsonb
language plpgsql security definer set search_path = shop, pg_temp as $$
declare v_next bigint;
begin
  perform 1 from conversations where id = p_conv and lease_token = p_token for update;
  if not found then
    raise exception 'lease lost for conversation %', p_conv;
  end if;

  update messages set processed_at = now()
   where conversation_id = p_conv and id = any (p_msg_ids) and processed_at is null;
  if coalesce(trim(p_reply), '') <> '' then
    insert into messages (conversation_id, role, content, processed_at) values (p_conv, 'assistant', p_reply, now());
  end if;
  if p_model is not null then
    insert into usage_log (conversation_id, model, input_tokens, output_tokens, steps)
    values (p_conv, p_model, coalesce(p_input, 0), coalesce(p_output, 0), coalesce(p_steps, 0));
  end if;

  update conversations
     set lease_token = null, lease_until = null,
         mode = case when p_handoff is not null then 'human' else mode end,
         handoff_reason = coalesce(p_handoff, handoff_reason)
   where id = p_conv;

  select max(id) into v_next from messages
   where conversation_id = p_conv and role = 'customer' and processed_at is null;
  return jsonb_build_object('pending', v_next is not null and p_handoff is null, 'next_msg', v_next);
end $$;

-- Staff hand the conversation back to the bot.
create or replace function shop.resume_bot(p_conv text) returns void
language sql security definer set search_path = shop, pg_temp as $$
  update conversations set mode = 'bot', handoff_reason = null where id = p_conv
$$;
