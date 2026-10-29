// Postgres functions on a real (in-process) Postgres: intake, leases, tool scoping, return rules, permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './sim.mjs';

const one = async (db, sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
const tool = (db, conv, name, args = {}) => one(db, 'select shop.run_tool($1, $2, $3::jsonb)', [conv, name, JSON.stringify(args)]);
const identified = async (db, conv, email = 'dana@example.com', order = '1042') => {
  await one(db, "select shop.intake_record($1, 'x', 'hi')", [conv]);
  return tool(db, conv, 'identify_customer', { email, order_number: order });
};

test('intake: duplicates ignored, only the newest message claims, one lease at a time', async () => {
  const db = await freshDb();
  const m1 = await one(db, "select shop.intake_record('c1', 'ext-1', 'hello')");
  assert.equal(await one(db, "select shop.intake_record('c1', 'ext-1', 'hello')"), null, 'same channel message twice');
  const m2 = await one(db, "select shop.intake_record('c1', 'ext-2', 'are you there?')");
  assert.equal(await one(db, 'select shop.intake_claim($1, $2)', ['c1', m1]), null, 'older message stops');
  const claim = await one(db, 'select shop.intake_claim($1, $2)', ['c1', m2]);
  assert.deepEqual(claim.messages.map((m) => m.text), ['hello', 'are you there?'], 'burst becomes one turn');
  assert.equal(await one(db, 'select shop.intake_claim($1, null)', ['c1']), null, 'lease held');

  // A message arrives mid-turn: finish reports it, and the next claim gets it.
  const m3 = await one(db, "select shop.intake_record('c1', 'ext-3', 'order 1042')");
  const fin = await one(db, "select shop.intake_finish('c1', $1::uuid, 'Hi! How can I help?', $2::bigint[], 'm', 10, 5, 1, null)", [claim.token, `{${m1},${m2}}`]);
  assert.deepEqual(fin, { pending: true, next_msg: m3 });
  const next = await one(db, 'select shop.intake_claim($1, $2)', ['c1', m3]);
  assert.deepEqual(next.messages.map((m) => m.text), ['order 1042']);
  assert.deepEqual(next.history.map((h) => h.role), ['customer', 'customer', 'assistant']);
});

test('intake: a run that lost its lease cannot save', async () => {
  const db = await freshDb();
  const m = await one(db, "select shop.intake_record('c2', 'e', 'hi')");
  await one(db, 'select shop.intake_claim($1, $2)', ['c2', m]);
  await assert.rejects(one(db, "select shop.intake_finish('c2', gen_random_uuid(), 'x', '{}'::bigint[], null, 0, 0, 0, null)"), /lease lost/);
});

test('intake: an expired lease can be taken over', async () => {
  const db = await freshDb();
  const m = await one(db, "select shop.intake_record('c3', 'e', 'hi')");
  await one(db, 'select shop.intake_claim($1, $2)', ['c3', m]);
  await db.query("update shop.conversations set lease_until = now() - interval '1 second' where id = 'c3'");
  assert.ok(await one(db, 'select shop.intake_claim($1, $2)', ['c3', m]));
});

test('intake: after a handoff the bot stays out until staff resume it', async () => {
  const db = await freshDb();
  const m = await one(db, "select shop.intake_record('c4', 'e1', 'human please')");
  const c = await one(db, 'select shop.intake_claim($1, $2)', ['c4', m]);
  const fin = await one(db, "select shop.intake_finish('c4', $1::uuid, 'Passing you on', $2::bigint[], null, 0, 0, 0, 'customer asked')", [c.token, `{${m}}`]);
  assert.equal(fin.pending, false);
  const m2 = await one(db, "select shop.intake_record('c4', 'e2', 'hello??')");
  assert.equal(await one(db, 'select shop.intake_claim($1, $2)', ['c4', m2]), null);
  await db.query("select shop.resume_bot('c4')");
  const m3 = await one(db, "select shop.intake_record('c4', 'e3', 'back')");
  assert.ok(await one(db, 'select shop.intake_claim($1, $2)', ['c4', m3]));
});

test('tools: nothing about orders before identification; wrong details never say which part', async () => {
  const db = await freshDb();
  await one(db, "select shop.intake_record('t1', 'e', 'hi')");
  assert.deepEqual(await tool(db, 't1', 'list_orders'), { ok: false, error: 'NOT_IDENTIFIED' });
  assert.deepEqual(await tool(db, 't1', 'order_details', { order_number: '1042' }), { ok: false, error: 'NOT_IDENTIFIED' });
  assert.deepEqual(await tool(db, 't1', 'identify_customer', { email: 'dana@example.com', order_number: '1050' }), { ok: false, error: 'NO_MATCH' }, "someone else's order");
  assert.deepEqual(await tool(db, 't1', 'identify_customer', { email: ' DANA@Example.com ', order_number: '#1042' }), { ok: true, name: 'Dana Reyes' });
});

test('tools: identification attempts are limited per hour', async () => {
  const db = await freshDb();
  await one(db, "select shop.intake_record('t2', 'e', 'hi')");
  for (let i = 0; i < 5; i++) await tool(db, 't2', 'identify_customer', { email: 'x@example.com', order_number: String(i) });
  assert.deepEqual(await tool(db, 't2', 'identify_customer', { email: 'dana@example.com', order_number: '1042' }), { ok: false, error: 'TOO_MANY_ATTEMPTS' });
});

test("tools: an identified customer can't see another customer's order", async () => {
  const db = await freshDb();
  await identified(db, 't3');
  assert.deepEqual(await tool(db, 't3', 'order_details', { order_number: '1050' }), { ok: false, error: 'ORDER_NOT_FOUND' });
  assert.deepEqual(await tool(db, 't3', 'start_return', { order_number: '1050', reason: 'x' }), { ok: false, error: 'ORDER_NOT_FOUND' });
  const list = await tool(db, 't3', 'list_orders');
  assert.deepEqual(list.orders.map((o) => o.order_number), ['1043', '1042', '1001']);
  const d = await tool(db, 't3', 'order_details', { order_number: '1042' });
  assert.equal(d.order.tracking.carrier, 'UPS');
  assert.equal(d.order.total, '129.00 USD');
});

test('returns: window, not delivered, final sale, partial items, idempotent', async () => {
  const db = await freshDb();
  await identified(db, 'r1');
  const closed = await tool(db, 'r1', 'check_return', { order_number: '1001' });
  assert.equal(closed.reason, 'RETURN_WINDOW_CLOSED');
  assert.equal(closed.window_days, 30);
  assert.equal((await tool(db, 'r1', 'start_return', { order_number: '1043', reason: 'x' })).error, 'NOT_DELIVERED_YET');
  const ok = await tool(db, 'r1', 'check_return', { order_number: '1042' });
  assert.equal(ok.eligible, true);
  assert.equal(ok.days_left, 22);
  assert.equal((await tool(db, 'r1', 'start_return', { order_number: '1042', reason: 'x', skus: ['NOPE'] })).error, 'ITEM_NOT_RETURNABLE');

  const first = await tool(db, 'r1', 'start_return', { order_number: '1042', reason: 'too big', skus: ['POUR-SAND'] });
  assert.equal(first.ok, true);
  assert.match(first.rma, /^RMA-[0-9A-F]{6}$/);
  assert.deepEqual(first.items, ['Ceramic Pour-Over Set (Sand)']);
  const again = await tool(db, 'r1', 'start_return', { order_number: '1042', reason: 'too big' });
  assert.deepEqual([again.already_open, again.rma], [true, first.rma]);
  assert.equal(await one(db, "select count(*)::int from shop.returns where order_id = (select id from shop.orders where number = '1042')"), 1);

  // Sam's only delivered order is all final sale.
  await identified(db, 'r2', 'sam@example.com', '1050');
  assert.equal((await tool(db, 'r2', 'check_return', { order_number: '1050' })).reason, 'FINAL_SALE_ONLY');
});

test('tools: unknown tool, junk arguments, unknown conversation; every call logged', async () => {
  const db = await freshDb();
  await one(db, "select shop.intake_record('u1', 'e', 'hi')");
  assert.deepEqual(await tool(db, 'u1', 'drop_tables'), { ok: false, error: 'UNKNOWN_TOOL' });
  assert.deepEqual(await one(db, "select shop.run_tool('u1', 'order_details', '[1,2]'::jsonb)"), { ok: false, error: 'NOT_IDENTIFIED' });
  await assert.rejects(tool(db, 'nope', 'list_orders'), /unknown conversation/);
  assert.equal(await one(db, "select count(*)::int from shop.tool_log where conversation_id = 'u1'"), 2);
});

test("permissions: the app role can call the functions but can't touch tables", async () => {
  const db = await freshDb();
  await db.exec('set role shop_agent');
  await assert.rejects(db.query('select * from shop.orders'), /permission denied/);
  await assert.rejects(db.query("update shop.returns set status = 'refunded'"), /permission denied/);
  assert.ok(await one(db, "select shop.intake_record('p1', 'e', 'hi')"));
  assert.deepEqual(await tool(db, 'p1', 'list_orders'), { ok: false, error: 'NOT_IDENTIFIED' });
  await assert.rejects(db.query("select shop.tool_identify_customer('p1', '{}')"), /permission denied/, 'inner tool functions are not callable directly');
});
