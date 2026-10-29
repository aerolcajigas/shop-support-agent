// One agent turn, as small pure steps the n8n workflow calls in order:
//   startTurn -> [requestBody -> (Claude) -> afterModel -> (Postgres tools) -> afterTools]* -> finishTurn
// Plain JS, no imports: build.mjs pastes it into the n8n Code nodes, and the tests drive the same functions with a
// scripted model and a real Postgres (PGlite). Everything below "@export" is left out of n8n.

const DEFAULTS = {
  model: 'claude-haiku-5-5',
  maxTokens: 1024,
  maxSteps: 6,           // model calls per turn; past this the customer gets a holding message and a human
  maxReplyChars: 1200,
  systemPrompt: 'You are a helpful store assistant.',
  tools: [],
  text: {
    handoffAsked: "Sure, I'm passing you to our team now. Someone will reply here shortly.",
    handoffTool: 'I\'ve passed this to our team. Someone will reply here shortly.',
    tooManySteps: 'Sorry, this is taking me longer than it should. A team member will reply here shortly.',
    modelDown: "Sorry, I'm having trouble right now. A team member will reply here shortly.",
    returnOpened: 'Your return for order #{order} is open. Your return code is {rma}. We\'ll email you the return label and instructions. Items: {items}.',
    returnAlreadyOpen: 'You already have an open return for order #{order}: {rma}. Your return label and instructions were sent by email.',
  },
};
const cfgOf = (c) => ({ ...DEFAULTS, ...(c || {}), text: { ...DEFAULTS.text, ...((c && c.text) || {}) } });
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => (v[k] == null ? '' : String(v[k])));

// Asking for a person is handled without the model: it's the one request that must always work.
const HUMAN_RE = /\b(talk|speak|chat)\s+(to|with)\s+(a\s+)?(human|person|someone|agent|representative|real person)\b|\b(human|real person|live agent|customer service rep(resentative)?)\s*(please|pls)?\s*[.!?]*$|^\s*(agent|human|representative)\s*[.!?]*\s*$/i;

// claim: shop.intake_claim(...) result. Returns the turn state carried through the whole loop.
function startTurn(claim, c) {
  const cfg = cfgOf(c);
  const newText = claim.messages.map((m) => m.text).join('\n').trim();
  const state = {
    conv: claim.conversation_id, token: claim.token, msgIds: claim.messages.map((m) => m.id),
    model: cfg.model, steps: 0, usage: { input: 0, output: 0 }, returns: [], handoff: null, reply: '', skipModel: false,
    messages: toMessages(claim.history, newText),
    system: `${cfg.systemPrompt}\n\n<context>\n${JSON.stringify(claim.context)}\n</context>`,
  };
  if (HUMAN_RE.test(newText)) {
    state.skipModel = true;
    state.handoff = 'customer asked for a person';
    state.reply = cfg.text.handoffAsked;
  }
  return state;
}

// History + the new messages -> Claude's alternating user/assistant list (starts with user, same roles merged).
function toMessages(history, newText) {
  const out = [];
  const push = (role, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else out.push({ role, content: text });
  };
  for (const h of history || []) push(h.role === 'assistant' ? 'assistant' : 'user', h.text);
  while (out.length && out[0].role !== 'user') out.shift();
  push('user', newText || '(empty message)');
  return out;
}

function requestBody(state, c) {
  const cfg = cfgOf(c);
  return { model: state.model, max_tokens: cfg.maxTokens, system: state.system, tools: cfg.tools, messages: state.messages };
}

// res: Anthropic Messages API response. Returns { state, done } or { state, done: false, calls: [{ id, name, input }] }.
function afterModel(state, res, c) {
  const cfg = cfgOf(c);
  if (!res || !Array.isArray(res.content)) throw new Error('Claude returned no content: ' + JSON.stringify(res).slice(0, 300));
  const s = clone(state);
  s.steps += 1;
  s.usage.input += (res.usage && res.usage.input_tokens) || 0;
  s.usage.output += (res.usage && res.usage.output_tokens) || 0;
  s.messages.push({ role: 'assistant', content: res.content });
  const calls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));

  if (!calls.length) {
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    s.reply = finalReply(s, text, cfg);
    return { state: s, done: true };
  }
  if (s.steps >= cfg.maxSteps) {
    s.reply = cfg.text.tooManySteps;
    s.handoff = 'assistant step limit';
    return { state: s, done: true };
  }
  return { state: s, done: false, calls };
}

// results[i] = shop.run_tool(...) for calls[i]. Adds the tool_result blocks and remembers what matters for the reply.
function afterTools(state, calls, results) {
  const s = clone(state);
  s.messages.push({
    role: 'user',
    content: calls.map((call, i) => ({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(results[i]) })),
  });
  calls.forEach((call, i) => {
    const r = results[i] || {};
    if (call.name === 'start_return' && r.ok) s.returns.push(r);
    if (call.name === 'handoff' && r.ok) s.handoff = r.reason || 'assistant handoff';
  });
  return s;
}

// The model writes the conversation, but the replies that commit the store to something are written by code:
// a return the model "confirms" in its own words could name the wrong items or a code that doesn't exist.
function finalReply(s, modelText, cfg) {
  if (s.returns.length) {
    return s.returns.map((r) => r.already_open
      ? fill(cfg.text.returnAlreadyOpen, { order: r.order_number, rma: r.rma })
      : fill(cfg.text.returnOpened, { order: r.order_number, rma: r.rma, items: (r.items || []).join(', ') })).join('\n\n');
  }
  const text = cleanReply(modelText, cfg);
  if (s.handoff) return text || cfg.text.handoffTool;
  return text;
}

// Last line of defense on model text: no leaked tool names / error codes / context tags, no runaway length.
const TOOL_NAMES = /\b(identify_customer|list_orders|order_details|check_return|start_return|handoff|run_tool)\b/g;
const CODES = /\b(NOT_IDENTIFIED|NO_MATCH|ORDER_NOT_FOUND|NOT_DELIVERED_YET|RETURN_WINDOW_CLOSED|RETURN_ALREADY_OPEN|FINAL_SALE_ONLY|ITEM_NOT_RETURNABLE|TOO_MANY_ATTEMPTS|UNKNOWN_TOOL|ORDER_CANCELLED)\b/g;
function cleanReply(text, c) {
  const cfg = cfgOf(c);
  let t = String(text || '')
    .replace(/<\/?(context|thinking|system)[^>]*>[\s\S]*?(<\/(context|thinking|system)>|$)/gi, '')
    .replace(TOOL_NAMES, '').replace(CODES, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
  if (t.length > cfg.maxReplyChars) t = t.slice(0, cfg.maxReplyChars - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

// Model call failed after retries: answer the customer anyway and bring in a person.
function modelFailed(state, c) {
  const cfg = cfgOf(c);
  return { ...clone(state), reply: cfg.text.modelDown, handoff: 'model unavailable' };
}

// Arguments for shop.intake_finish(...), in order.
function finishTurn(state) {
  return {
    conv: state.conv, token: state.token, reply: state.reply, msgIds: state.msgIds,
    model: state.skipModel ? null : state.model, input: state.usage.input, output: state.usage.output, steps: state.steps,
    handoff: state.handoff,
  };
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// @export
if (typeof module !== 'undefined') module.exports = { DEFAULTS, HUMAN_RE, startTurn, toMessages, requestBody, afterModel, afterTools, finalReply, cleanReply, modelFailed, finishTurn };
