// Generates workflows/agent.json from src/core.js + prompts/ + config.json (or config.example.json).
//   node build.mjs [--deploy]   (--deploy needs env N8N_API_URL, N8N_API_KEY)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadCore, makeBuilder, deploy } from './lib/n8n.mjs';

const here = (p) => new URL(p, import.meta.url);
const cfg = JSON.parse(readFileSync(here(existsSync(here('config.json')) ? 'config.json' : 'config.example.json'), 'utf8'));
const { credentials: C, webhookPath, replyUrl, debounceSeconds, ...logic } = cfg;
logic.systemPrompt = readFileSync(here('prompts/system.md'), 'utf8').trim();
logic.tools = JSON.parse(readFileSync(here('prompts/tools.json'), 'utf8'));
const b = makeBuilder({ core: loadCore(here('src/core.js')), config: logic });

const nodes = [
  // ---- intake: record, de-dupe, debounce, claim ----
  b.webhook('Incoming Message', webhookPath, C.webhookAuth),
  b.pg('Record Message', 'select shop.intake_record($1, $2, $3) as msg_id',
    '={{ [ String($json.body.conversation_id), String($json.body.message_id), String($json.body.text || "") ] }}', C.postgres),
  b.code('New Message?', `
const out = [];
$input.all().forEach((r, i) => {
  if (r.json.msg_id == null) return; // duplicate delivery of the same channel message
  out.push({ json: { conv: String($('Incoming Message').all()[i].json.body.conversation_id), msg_id: Number(r.json.msg_id) } });
});
return out;`),
  b.wait('Debounce', debounceSeconds),
  b.pg('Claim Turn', 'select shop.intake_claim($1, $2::bigint) as claim', '={{ [ $json.conv, $json.msg_id ] }}', C.postgres),
  b.code('Start Turn', `
const claim = $input.first().json.claim;
if (!claim) return []; // a newer message will run, a human has the chat, or another run holds the lease
return [{ json: { state: startTurn(claim, CONFIG) } }];`),
  b.ifTrue('Skip Model?', '={{ $json.state.skipModel }}'),

  // ---- tool loop ----
  // Keeps the state next to the model call: the HTTP node's output is only Claude's response, so "After Model" reads
  // the state back from here (.last() = this loop iteration).
  b.code('Prepare Call', `
const state = $input.first().json.state;
return [{ json: { state, body: requestBody(state, CONFIG) } }];`),
  { ...b.http('Call Claude', { credType: 'anthropicApi', cred: C.anthropic, method: 'POST', url: 'https://api.anthropic.com/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' }, jsonBody: '={{ JSON.stringify($json.body) }}' }),
    onError: 'continueErrorOutput' },
  b.code('After Model', `
const state = $('Prepare Call').last().json.state;
const r = afterModel(state, $input.first().json, CONFIG);
if (r.done) return [{ json: { done: true, state: r.state } }];
return r.calls.map((call, i) => ({ json: { done: false, conv: r.state.conv, tool: call.name, args: JSON.stringify(call.input), call, state: i === 0 ? r.state : null } }));`),
  b.ifTrue('Done?', '={{ $json.done }}'),
  // conversation id from the workflow, tool + args from the model
  b.pg('Run Tool', 'select shop.run_tool($1, $2, $3::jsonb) as result', '={{ [ $json.conv, $json.tool, $json.args ] }}', C.postgres),
  b.code('After Tools', `
const calls = $('After Model').all().map((i) => i.json);
const results = $input.all().map((i) => i.json.result);
return [{ json: { state: afterTools(calls[0].state, calls.map((c) => c.call), results) } }];`),
  b.code('Model Failed', `
// Claude still failing after retries: the customer gets a holding message and a person takes over.
return [{ json: { state: modelFailed($('Prepare Call').last().json.state, CONFIG) } }];`),

  // ---- finish ----
  b.code('Finish Turn', `
return [{ json: finishTurn($input.first().json.state) }];`),
  b.pg('Save Turn', 'select shop.intake_finish($1, $2::uuid, $3, $4::bigint[], $5, $6::int, $7::int, $8::int, $9) as fin',
    '={{ [ $json.conv, $json.token, $json.reply, "{" + $json.msgIds.join(",") + "}", $json.model, $json.input, $json.output, $json.steps, $json.handoff ] }}', C.postgres),
  b.code('Reply Out', `
const f = $('Finish Turn').last().json;
return f.reply ? [{ json: { conversation_id: f.conv, text: f.reply, handoff: !!f.handoff } }] : [];`),
  b.httpHeaderAuth('Send Reply', replyUrl, C.replyAuth, '={{ JSON.stringify($json) }}'),
  b.code('More Messages?', `
// Messages that arrived during the turn get their own turn right away (the lease made their runs stop).
const fin = $input.first().json.fin;
return fin && fin.pending ? [{ json: { conv: $('Finish Turn').last().json.conv, msg_id: Number(fin.next_msg) } }] : [];`),
];

const wf = b.workflow('Shop Agent / Turn', nodes,
  'Customer message -> de-dupe, debounce, lease -> Claude tool loop over Postgres functions -> reply. One turn per conversation at a time.',
  [
    ['Incoming Message', 'Record Message'], ['Record Message', 'New Message?'], ['New Message?', 'Debounce'], ['Debounce', 'Claim Turn'],
    ['Claim Turn', 'Start Turn'], ['Start Turn', 'Skip Model?'],
    ['Skip Model?', 'Finish Turn', 0], ['Skip Model?', 'Prepare Call', 1],
    ['Prepare Call', 'Call Claude'], ['Call Claude', 'After Model', 0], ['Call Claude', 'Model Failed', 1],
    ['After Model', 'Done?'], ['Done?', 'Finish Turn', 0], ['Done?', 'Run Tool', 1],
    ['Run Tool', 'After Tools'], ['After Tools', 'Prepare Call'],
    ['Model Failed', 'Finish Turn'],
    ['Finish Turn', 'Save Turn'], ['Save Turn', 'Reply Out'], ['Reply Out', 'Send Reply'],
    ['Save Turn', 'More Messages?'], ['More Messages?', 'Claim Turn'],
  ]);

mkdirSync(here('workflows/'), { recursive: true });
writeFileSync(here('workflows/agent.json'), JSON.stringify(wf, null, 2) + '\n');
console.log('wrote workflows/agent.json');
if (process.argv.includes('--deploy')) await deploy([wf]);
