-- 001_schema.sql: store data the agent may read (customers, orders, returns) and the agent's own state
-- (conversations, messages, leases, tool and usage logs). Everything lives in schema "shop".

create schema if not exists shop;

create table shop.settings (
  key   text primary key,
  value jsonb not null
);
insert into shop.settings (key, value) values
  ('store_name', '"Demo Store"'),
  ('return_window_days', '30'),
  ('lease_seconds', '90'),
  ('history_messages', '20'),
  ('identify_attempts_per_hour', '5')
on conflict (key) do nothing;

create or replace function shop.setting(p_key text) returns jsonb
language sql stable as $$ select value from shop.settings where key = p_key $$;

create table shop.customers (
  id         bigserial primary key,
  email      text not null unique check (email = lower(email)),
  name       text not null,
  created_at timestamptz not null default now()
);

create table shop.orders (
  id              bigserial primary key,
  number          text not null unique,               -- what the customer sees, e.g. "1042"
  customer_id     bigint not null references shop.customers,
  status          text not null check (status in ('paid', 'fulfilled', 'delivered', 'cancelled')),
  placed_at       timestamptz not null,
  delivered_at    timestamptz,
  total           numeric(12, 2) not null,
  currency        text not null default 'USD',
  carrier         text,
  tracking_number text,
  tracking_url    text
);

create table shop.order_items (
  id         bigserial primary key,
  order_id   bigint not null references shop.orders on delete cascade,
  sku        text not null,
  title      text not null,
  qty        int not null check (qty > 0),
  price      numeric(12, 2) not null,
  final_sale boolean not null default false
);

create table shop.returns (
  id              bigserial primary key,
  rma             text not null unique,
  order_id        bigint not null references shop.orders,
  skus            text[] not null,
  reason          text not null,
  status          text not null default 'open' check (status in ('open', 'received', 'refunded', 'rejected')),
  conversation_id text,
  created_at      timestamptz not null default now()
);
-- At most one open return per order: a retried tool call can't open a second one.
create unique index returns_one_open on shop.returns (order_id) where status = 'open';

-- ---------- agent state ----------

create table shop.conversations (
  id             text primary key,                     -- the chat channel's conversation id
  customer_id    bigint references shop.customers,     -- set only by identify_customer, never by the model
  mode           text not null default 'bot' check (mode in ('bot', 'human')),
  handoff_reason text,
  lease_token    uuid,
  lease_until    timestamptz,
  created_at     timestamptz not null default now()
);

create table shop.messages (
  id              bigserial primary key,
  conversation_id text not null references shop.conversations,
  external_id     text,                                 -- channel message id, for de-duplication
  role            text not null check (role in ('customer', 'assistant', 'staff')),
  content         text not null,
  created_at      timestamptz not null default now(),
  processed_at    timestamptz,
  unique (conversation_id, external_id)
);
create index messages_unprocessed on shop.messages (conversation_id, id) where processed_at is null;

create table shop.tool_log (
  id              bigserial primary key,
  conversation_id text not null,
  tool            text not null,
  args            jsonb not null,
  result          jsonb not null,
  at              timestamptz not null default now()
);
create index tool_log_conv on shop.tool_log (conversation_id, at);

create table shop.usage_log (
  id              bigserial primary key,
  conversation_id text not null,
  model           text not null,
  input_tokens    int not null,
  output_tokens   int not null,
  steps           int not null,
  at              timestamptz not null default now()
);
