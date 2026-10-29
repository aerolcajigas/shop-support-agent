// A small interpreter for the generated workflow (workflows/agent.json), so tests run the REAL workflow graph:
// same Code node source, same SQL and parameter expressions, same IF conditions and loop edges. Postgres nodes run
// on an in-process Postgres (PGlite), "Call Claude" goes to a scripted fake model, "Send Reply" is captured.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('../', import.meta.url);

export async function freshDb() {
  const db = new PGlite();
  for (const f of ['001_schema', '002_intake', '003_tools', '004_roles', 'seed_demo']) await db.exec(readFileSync(new URL(`db/${f}.sql`, root), 'utf8'));
  return db;
}

export const loadWorkflow = () => JSON.parse(readFileSync(new URL('workflows/agent.json', root), 'utf8'));

// n8n expression "={{ js }}" evaluated for one item.
function expr(value, $json, $) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const m = value.match(/^=\{\{([\s\S]*)\}\}$/);
  if (!m) throw new Error('unsupported expression ' + value);
  return new Function('$json', '$', `return (${m[1]});`)($json, $);
}

export async function runWorkflow({ db, model, body, staticData = {}, maxNodeRuns = 200 }) {
  const wf = loadWorkflow();
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const runs = {};       // node -> output items of its latest run
  const outbox = [];     // replies sent to the chat channel
  const trace = [];      // node names in execution order
  const $ = (name) => ({
    all: () => (runs[name] || []).map((json) => ({ json })),
    first: () => ({ json: (runs[name] || [])[0] }),
    last: () => ({ json: (runs[name] || []).at(-1) }),
  });

  async function exec(node, items) {
    switch (node.type) {
      case 'n8n-nodes-base.webhook':
      case 'n8n-nodes-base.wait':
      case 'n8n-nodes-base.noOp':
        return [items];
      case 'n8n-nodes-base.code': {
        const input = items.map((json) => ({ json }));
        const fn = new Function('$input', '$', '$getWorkflowStaticData', node.parameters.jsCode);
        return [fn({ all: () => input, first: () => input[0] }, $, () => staticData).map((i) => i.json)];
      }
      case 'n8n-nodes-base.postgres': {
        const out = [];
        for (const json of items) {
          const params = expr(node.parameters.options.queryReplacement, json, $);
          const res = await db.query(node.parameters.query, params);
          out.push(...res.rows);
        }
        return [out];
      }
      case 'n8n-nodes-base.if': {
        const cond = node.parameters.conditions.conditions[0];
        const t = [], f = [];
        for (const json of items) (expr(cond.leftValue, json, $) === true ? t : f).push(json);
        return [t, f];
      }
      case 'n8n-nodes-base.httpRequest': {
        if (node.name === 'Send Reply') { items.forEach((json) => outbox.push(JSON.parse(expr(node.parameters.jsonBody, json, $)))); return [items]; }
        const ok = [], err = [];
        for (const json of items) {
          try { ok.push(await model(JSON.parse(expr(node.parameters.jsonBody, json, $)))); } catch (e) { err.push({ error: { message: e.message } }); }
        }
        return [ok, err];
      }
      default: throw new Error('no simulator for ' + node.type);
    }
  }

  // Breadth-first like n8n's v1 order for this graph; every node runs once per incoming batch.
  const queue = [['Incoming Message', [{ body }]]];
  let count = 0;
  while (queue.length) {
    const [name, items] = queue.shift();
    if (!items.length) continue;
    if (++count > maxNodeRuns) throw new Error('workflow did not finish (loop?)');
    const node = byName[name];
    trace.push(name);
    const outputs = await exec(node, items);
    runs[name] = outputs.flat();
    const conns = (wf.connections[name] && wf.connections[name].main) || [];
    conns.forEach((targets, i) => { for (const t of targets) queue.push([t.node, outputs[i] || []]); });
  }
  return { outbox, trace, staticData };
}

// Scripted Claude: a list of steps; each is a function(body) -> content blocks, or an Error to throw.
export function scriptedModel(steps) {
  const calls = [];
  let i = 0;
  const fn = async (body) => {
    calls.push(body);
    const step = steps[Math.min(i++, steps.length - 1)];
    const content = typeof step === 'function' ? await step(body) : step;
    if (content instanceof Error) throw content;
    return { id: `msg_${i}`, type: 'message', role: 'assistant', content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 } };
  };
  fn.calls = calls;
  return fn;
}
export const tool = (name, input, id = `tu_${name}_${Math.random().toString(36).slice(2, 7)}`) => ({ type: 'tool_use', id, name, input });
export const text = (t) => ({ type: 'text', text: t });
// The tool_result the model received for a given tool call id, from the request body of the next step.
export const toolResult = (body, id) => {
  for (const m of body.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result' && b.tool_use_id === id) return JSON.parse(b.content);
  return undefined;
};
