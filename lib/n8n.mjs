// Small helpers that build n8n workflow JSON. Each workflow's logic lives in src/core.js; build.mjs pastes it into
// the Code nodes (everything above the "// @export" line), so the workflows and the tests run the same code.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function loadCore(url) {
  return readFileSync(url, 'utf8').split('// @export')[0].trim();
}

export function makeBuilder({ core, config, timeZone }) {
  const PRELUDE = `${core}\n\nconst CONFIG = ${JSON.stringify(config)};\n`;
  let x = 0;
  const at = () => [(x++) * 260, 300];

  const b = {
    code: (name, js) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: at(),
      parameters: { mode: 'runOnceForAllItems', jsCode: `${PRELUDE}\n// ---- ${name} ----\n${js.trim()}\n` } }),

    schedule: (name, rule) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: at(),
      parameters: { rule: { interval: [rule] } } }),

    // Webhook protected by a header token (n8n "Header Auth" credential). The caller sends the same header.
    webhook: (name, path, cred) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: at(),
      webhookId: randomUUID(), credentials: { httpHeaderAuth: cred },
      parameters: { httpMethod: 'POST', path, authentication: 'headerAuth', responseMode: 'onReceived', options: {} } }),

    // HTTP Request with a predefined credential type. url/method/body may be n8n expressions.
    http: (name, { credType, cred, method = 'GET', url, jsonBody, headers }) => ({
      id: randomUUID(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: at(),
      retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, credentials: { [credType]: cred },
      parameters: {
        method, url, authentication: 'predefinedCredentialType', nodeCredentialType: credType,
        ...(headers ? { sendHeaders: true, specifyHeaders: 'keypair', headerParameters: { parameters: Object.entries(headers).map(([name, value]) => ({ name, value })) } } : {}),
        ...(jsonBody ? { sendBody: true, specifyBody: 'json', jsonBody } : {}),
        options: {},
      },
    }),

    node: (name, type, typeVersion, parameters, extra = {}) => ({ id: randomUUID(), name, type, typeVersion, position: at(), parameters, ...extra }),

    // Postgres "execute query" with $1, $2 ... parameters (n8n passes them safely, no string building).
    pg: (name, query, params, cred) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position: at(),
      credentials: { postgres: cred },
      parameters: { operation: 'executeQuery', query, options: { queryReplacement: params, queryBatching: 'independently' } } }),

    ifTrue: (name, expr) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: at(),
      parameters: {
        conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{ id: randomUUID(), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
        looseTypeValidation: true, options: {} } }),

    wait: (name, seconds) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: at(), webhookId: randomUUID(),
      parameters: { resume: 'timeInterval', amount: seconds, unit: 'seconds' } }),

    noOp: (name) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: at(), parameters: {} }),

    // POST to any URL with a Header Auth credential (e.g. your chat channel's "send message" endpoint).
    httpHeaderAuth: (name, url, cred, jsonBody) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: at(),
      retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, credentials: { httpHeaderAuth: cred },
      parameters: { method: 'POST', url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, specifyBody: 'json', jsonBody, options: {} } }),

    // nodes: in order. edges: optional extra/branch edges [from, to, outputIndex]; without edges it's a straight chain.
    workflow(name, nodes, notes, edges) {
      const connections = {};
      const add = (from, to, out = 0) => {
        const c = connections[from] || (connections[from] = { main: [] });
        while (c.main.length <= out) c.main.push([]);
        c.main[out].push({ node: to, type: 'main', index: 0 });
      };
      if (edges) for (const [f, t, o] of edges) add(f, t, o);
      else for (let i = 0; i < nodes.length - 1; i++) add(nodes[i].name, nodes[i + 1].name);
      x = 0;
      return { name, nodes, connections, settings: { executionOrder: 'v1', ...(timeZone ? { timezone: timeZone } : {}) }, meta: { notes } };
    },
  };
  return b;
}

// GraphQL / REST helpers pasted into Code nodes that read API responses.
export const GQL_CHECK = `
function gql(item) {
  const b = item.json;
  if (b.errors && b.errors.length) throw new Error('Shopify GraphQL: ' + b.errors.map((e) => e.message).join('; '));
  if (!b.data) throw new Error('Shopify GraphQL: empty response');
  return b.data;
}`;

export async function deploy(workflows) {
  const base = String(process.env.N8N_API_URL || '').replace(/\/$/, ''), key = process.env.N8N_API_KEY;
  if (!base || !key) throw new Error('set N8N_API_URL and N8N_API_KEY');
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
  const existing = (await api('GET', '/api/v1/workflows?limit=250')).data;
  for (const wf of workflows) {
    const { meta, ...body } = wf; // the public API rejects unknown top-level fields
    const found = existing.find((w) => w.name === wf.name);
    if (found) await api('PUT', `/api/v1/workflows/${found.id}`, body); else await api('POST', '/api/v1/workflows', body);
    console.log(`${found ? 'updated' : 'created'} ${wf.name} (inactive until you activate it in n8n)`);
  }
}
