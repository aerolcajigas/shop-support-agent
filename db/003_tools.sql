-- 003_tools.sql: the agent's tools, as SQL functions. The model chooses a tool and its arguments; Postgres decides
-- everything that matters (who the customer is, which orders they may see, whether a return is allowed).
--   * The conversation id comes from the workflow, never from the model.
--   * Order data is only returned for orders of the customer identified in THIS conversation.
--   * Answers are short codes + facts, so the model can't "round up" a policy.

create or replace function shop.current_customer(p_conv text) returns bigint
language sql stable security definer set search_path = shop, pg_temp as $$
  select customer_id from conversations where id = p_conv
$$;

create or replace function shop.norm_order_number(p text) returns text
language sql immutable as $$ select nullif(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z-]', '', 'g'), '') $$;

-- The customer's own order, or null.
create or replace function shop.own_order(p_conv text, p_number text) returns shop.orders
language sql stable security definer set search_path = shop, pg_temp as $$
  select o.* from orders o
   where o.number = norm_order_number(p_number) and o.customer_id = current_customer(p_conv)
$$;

-- Return rules in one place: delivered, inside the window, not final sale, no open return.
create or replace function shop.return_eligibility(p_order shop.orders) returns jsonb
language plpgsql stable security definer set search_path = shop, pg_temp as $$
declare
  v_window int := (setting('return_window_days'))::int;
  v_days_left int;
  v_open text;
  v_items jsonb;
begin
  select rma into v_open from returns where order_id = p_order.id and status = 'open';
  if v_open is not null then
    return jsonb_build_object('eligible', false, 'reason', 'RETURN_ALREADY_OPEN', 'rma', v_open);
  end if;
  if p_order.status = 'cancelled' then
    return jsonb_build_object('eligible', false, 'reason', 'ORDER_CANCELLED');
  end if;
  if p_order.status <> 'delivered' or p_order.delivered_at is null then
    return jsonb_build_object('eligible', false, 'reason', 'NOT_DELIVERED_YET', 'status', p_order.status);
  end if;
  v_days_left := v_window - (current_date - (p_order.delivered_at at time zone 'UTC')::date);
  if v_days_left < 0 then
    return jsonb_build_object('eligible', false, 'reason', 'RETURN_WINDOW_CLOSED',
      'window_days', v_window, 'delivered_on', to_char(p_order.delivered_at, 'YYYY-MM-DD'));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('sku', sku, 'title', title, 'qty', qty) order by id), '[]') into v_items
    from order_items where order_id = p_order.id and not final_sale;
  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('eligible', false, 'reason', 'FINAL_SALE_ONLY');
  end if;
  return jsonb_build_object('eligible', true, 'days_left', v_days_left, 'returnable_items', v_items,
    'final_sale_items', (select coalesce(jsonb_agg(title order by id), '[]') from order_items where order_id = p_order.id and final_sale));
end $$;

create or replace function shop.order_summary(p_order shop.orders) returns jsonb
language sql stable security definer set search_path = shop, pg_temp as $$
  select jsonb_build_object(
    'order_number', p_order.number,
    'status', p_order.status,
    'placed_on', to_char(p_order.placed_at, 'YYYY-MM-DD'),
    'delivered_on', to_char(p_order.delivered_at, 'YYYY-MM-DD'),
    'total', to_char(p_order.total, 'FM999999990.00') || ' ' || p_order.currency,
    'tracking', case when p_order.tracking_number is not null then
      jsonb_build_object('carrier', p_order.carrier, 'number', p_order.tracking_number, 'url', p_order.tracking_url) end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('title', title, 'qty', qty, 'final_sale', final_sale) order by id), '[]')
                from order_items where order_id = p_order.id),
    'open_return', (select rma from returns where order_id = p_order.id and status = 'open')
  )
$$;

-- ---------- the tools ----------

-- Links the conversation to a customer when the email and the order number belong together. The answer never says
-- which of the two was wrong, and failed attempts are limited per hour.
create or replace function shop.tool_identify_customer(p_conv text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = shop, pg_temp as $$
declare
  v_customer customers;
  v_fails int;
begin
  select count(*) into v_fails from tool_log
   where conversation_id = p_conv and tool = 'identify_customer' and at > now() - interval '1 hour' and result->>'ok' = 'false';
  if v_fails >= (setting('identify_attempts_per_hour'))::int then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS');
  end if;
  select cu.* into v_customer from customers cu join orders o on o.customer_id = cu.id
   where cu.email = lower(trim(p_args->>'email')) and o.number = norm_order_number(p_args->>'order_number');
  if v_customer.id is null then
    return jsonb_build_object('ok', false, 'error', 'NO_MATCH');
  end if;
  update conversations set customer_id = v_customer.id where id = p_conv;
  return jsonb_build_object('ok', true, 'name', v_customer.name);
end $$;

create or replace function shop.tool_list_orders(p_conv text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = shop, pg_temp as $$
begin
  if current_customer(p_conv) is null then return jsonb_build_object('ok', false, 'error', 'NOT_IDENTIFIED'); end if;
  return jsonb_build_object('ok', true, 'orders', (
    select coalesce(jsonb_agg(jsonb_build_object('order_number', number, 'status', status, 'placed_on', to_char(placed_at, 'YYYY-MM-DD'),
             'total', to_char(total, 'FM999999990.00') || ' ' || currency) order by placed_at desc), '[]')
      from (select * from orders where customer_id = current_customer(p_conv) order by placed_at desc limit 10) o));
end $$;

create or replace function shop.tool_order_details(p_conv text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = shop, pg_temp as $$
declare v_order orders;
begin
  if current_customer(p_conv) is null then return jsonb_build_object('ok', false, 'error', 'NOT_IDENTIFIED'); end if;
  v_order := own_order(p_conv, p_args->>'order_number');
  if v_order.id is null then return jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'order', order_summary(v_order));
end $$;

create or replace function shop.tool_check_return(p_conv text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = shop, pg_temp as $$
declare v_order orders;
begin
  if current_customer(p_conv) is null then return jsonb_build_object('ok', false, 'error', 'NOT_IDENTIFIED'); end if;
  v_order := own_order(p_conv, p_args->>'order_number');
  if v_order.id is null then return jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'order_number', v_order.number) || return_eligibility(v_order);
end $$;

-- Opens a return (RMA). Idempotent: a retried call returns the open return instead of making a second one.
create or replace function shop.tool_start_return(p_conv text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = shop, pg_temp as $$
declare
  v_order orders;
  v_elig  jsonb;
  v_skus  text[];
  v_bad   text[];
  v_rma   text;
  v_reason text := left(coalesce(nullif(trim(p_args->>'reason'), ''), 'not given'), 500);
begin
  if current_customer(p_conv) is null then return jsonb_build_object('ok', false, 'error', 'NOT_IDENTIFIED'); end if;
  v_order := own_order(p_conv, p_args->>'order_number');
  if v_order.id is null then return jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND'); end if;

  v_elig := return_eligibility(v_order);
  if v_elig->>'reason' = 'RETURN_ALREADY_OPEN' then
    return jsonb_build_object('ok', true, 'already_open', true, 'rma', v_elig->>'rma', 'order_number', v_order.number);
  end if;
  if not (v_elig->>'eligible')::boolean then
    return jsonb_build_object('ok', false, 'error', v_elig->>'reason') || (v_elig - 'eligible' - 'reason');
  end if;

  -- Which items: the ones asked for (must be returnable), or all returnable items.
  if jsonb_typeof(p_args->'skus') = 'array' and jsonb_array_length(p_args->'skus') > 0 then
    select array_agg(s) into v_skus from jsonb_array_elements_text(p_args->'skus') s;
    select array_agg(s) into v_bad from unnest(v_skus) s
     where s not in (select x->>'sku' from jsonb_array_elements(v_elig->'returnable_items') x);
    if v_bad is not null then
      return jsonb_build_object('ok', false, 'error', 'ITEM_NOT_RETURNABLE', 'skus', to_jsonb(v_bad));
    end if;
  else
    select array_agg(x->>'sku') into v_skus from jsonb_array_elements(v_elig->'returnable_items') x;
  end if;

  v_rma := 'RMA-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
  begin
    insert into returns (rma, order_id, skus, reason, conversation_id) values (v_rma, v_order.id, v_skus, v_reason, p_conv);
  exception when unique_violation then
    -- two calls raced: the other one won, return its RMA
    select rma into v_rma from returns where order_id = v_order.id and status = 'open';
    return jsonb_build_object('ok', true, 'already_open', true, 'rma', v_rma, 'order_number', v_order.number);
  end;
  return jsonb_build_object('ok', true, 'already_open', false, 'rma', v_rma, 'order_number', v_order.number,
    'items', (select jsonb_agg(title order by id) from order_items where order_id = v_order.id and sku = any (v_skus)));
end $$;

create or replace function shop.tool_handoff(p_conv text, p_args jsonb) returns jsonb
language sql security definer set search_path = shop, pg_temp as $$
  select jsonb_build_object('ok', true, 'handoff', true, 'reason', left(coalesce(nullif(trim(p_args->>'reason'), ''), 'not given'), 300))
$$;

-- The only entry point the workflow calls. Logs every call.
create or replace function shop.run_tool(p_conv text, p_tool text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = shop, pg_temp as $$
declare
  v_args jsonb := case when jsonb_typeof(p_args) = 'object' then p_args else '{}'::jsonb end;
  v_res  jsonb;
begin
  if not exists (select 1 from conversations where id = p_conv) then
    raise exception 'unknown conversation %', p_conv;
  end if;
  v_res := case p_tool
    when 'identify_customer' then tool_identify_customer(p_conv, v_args)
    when 'list_orders'       then tool_list_orders(p_conv, v_args)
    when 'order_details'     then tool_order_details(p_conv, v_args)
    when 'check_return'      then tool_check_return(p_conv, v_args)
    when 'start_return'      then tool_start_return(p_conv, v_args)
    when 'handoff'           then tool_handoff(p_conv, v_args)
    else jsonb_build_object('ok', false, 'error', 'UNKNOWN_TOOL')
  end;
  insert into tool_log (conversation_id, tool, args, result) values (p_conv, p_tool, v_args, v_res);
  return v_res;
end $$;
