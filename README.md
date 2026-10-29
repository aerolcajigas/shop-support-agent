# Shop Support Agent

An AI customer support agent for an online store, built on n8n, Claude and Postgres. It identifies the customer, looks
up orders and tracking, explains the return policy, opens returns, and hands off to a person when it should.

**The model chooses; Postgres decides.** Claude picks which tool to call and with what arguments. Everything that
matters (who the customer is, which orders they may see, whether a return is allowed) is decided by SQL functions.

## One agent turn

```
message in -> record (de-dupe) -> wait 3 s (a burst becomes one turn) -> claim (newest message + lease)
           -> "talk to a human"? -> hand off without the model
           -> Claude <-> tools (Postgres functions), max 6 steps
           -> save turn, release lease -> reply out
           -> messages that arrived mid-turn? run the next turn now
```

## Safety built into the database

- **Customer scoping.** The conversation id comes from the workflow, never from the model. Order tools only return
  orders of the customer identified in that conversation, so a fooled model still can't read someone else's order.
- **Identification** needs the checkout email plus an order number. It never says which one was wrong, and failed
  attempts are capped per hour.
- **Return rules in SQL:** delivered, inside the window, not final sale, one open return per order (unique index),
  so a retried tool call can't open a second return.
- **Leases.** One turn per conversation at a time. A slow run that lost its lease can't overwrite a newer one.
- **Least privilege.** The database role n8n uses can execute the five entry functions and nothing else. It has no
  table access.

## Safety built into the turn

- Replies that commit the store (the return confirmation and code) are **written by code from the database result**,
  not by the model.
- Model text is cleaned of tool names, error codes and context tags, and its length is capped.
- If Claude fails after retries, or loops past 6 steps, the customer gets a holding message and a person takes over.
- Every tool call and every turn's token usage is logged.

## Tests: 22, no API key or database server needed

```
npm install && npm test
```

- `test/db.test.mjs` runs the SQL on a real Postgres compiled to WebAssembly (PGlite): de-dupe, debounce, leases,
  handoff, scoping, rate limit, return rules, idempotency, role permissions.
- `test/turn.test.mjs` runs **the generated n8n workflow itself** through a small interpreter (`test/sim.mjs`). The
  Code nodes, SQL, parameter expressions, IF branches and loop edges are all the same as in n8n, with a scripted
  Claude. It covers a full return, a prompt injection attempt, handing off to a human, duplicate deliveries, Claude
  being down, the step limit, and a message arriving mid-turn.

## Layout

| Path | What |
|---|---|
| `db/` | Schema, intake (de-dupe, claim, finish), tools, role, demo data |
| `src/core.js` | The turn logic, pasted into the n8n Code nodes by `build.mjs` |
| `prompts/` | System prompt and the Claude tool definitions |
| `build.mjs` | Generates `workflows/agent.json` (`--deploy` pushes it through the n8n API) |

## Set up

1. Run `db/001`-`004` on Postgres. Create a login role and `grant shop_agent to <it>`. Load your orders into the
   `shop.customers`, `shop.orders` and `shop.order_items` tables, or swap the tool functions for views over your
   real store data.
2. In n8n, add credentials for Postgres (that login), Anthropic, and Header Auth for incoming messages and for
   your chat channel.
3. `cp config.example.json config.json`, then fill in the credential IDs and the URL replies are posted to.
   Run `node build.mjs`, then import the workflow and activate it.
4. Your chat channel POSTs `{ conversation_id, message_id, text }` to the webhook. Replies arrive at `replyUrl`
   as `{ conversation_id, text, handoff }`.

Not yet run against the live Claude API; the tests use a scripted model. The default model is `claude-haiku-5-5`.
