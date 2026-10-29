// Runs a generated Code node the way n8n does: same jsCode, with $input / $() / $getWorkflowStaticData mocked.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export const core = () => createRequire(import.meta.url)('../src/core.js');
export const wf = (f) => JSON.parse(readFileSync(new URL(`../workflows/${f}.json`, import.meta.url), 'utf8'));
export const node = (w, name) => {
  const n = w.nodes.find((n) => n.name === name);
  if (!n) throw new Error(`no node "${name}" in ${w.name}`);
  return n;
};

export function run(codeNode, inputs, { nodes = {}, staticData = {} } = {}) {
  const items = inputs.map((json) => ({ json }));
  const $input = { all: () => items, first: () => items[0] };
  const $ = (name) => ({ all: () => (nodes[name] || []).map((json) => ({ json })), first: () => ({ json: (nodes[name] || [])[0] }) });
  const fn = new Function('$input', '$', '$getWorkflowStaticData', codeNode.parameters.jsCode);
  return fn($input, $, () => staticData).map((i) => i.json);
}

// Every node in `connections` exists, every non-trigger node has an input, and nothing points at a missing node.
export function checkWiring(w) {
  const names = new Set(w.nodes.map((n) => n.name));
  const fed = new Set();
  for (const [from, c] of Object.entries(w.connections)) {
    if (!names.has(from)) throw new Error(`connection from missing node ${from}`);
    for (const out of c.main) for (const e of out) { if (!names.has(e.node)) throw new Error(`edge to missing node ${e.node}`); fed.add(e.node); }
  }
  for (const n of w.nodes) if (!/Trigger|trigger|webhook/.test(n.type) && !fed.has(n.name)) throw new Error(`node "${n.name}" has no input`);
  return true;
}
