import { fetch } from '@forge/api';
import { call, Refused } from './core/broker.js';
import { store } from './store.js';

export { adminResolver } from './admin.js';

const deps = {
  getOperation: store.getOperation,
  getConnection: store.getConnection,
  getSecret: store.getSecret,
  fetch,
  now: () => new Date().toISOString(),
  record: async (entry) => {
    console.log(JSON.stringify({ event: `call.${entry.outcome}`, ...entry }));
    await store.record(entry);
  },
};

// Rules and agents pass parameters as JSON text, since action inputs are scalar.
function parseParams(text) {
  if (text === undefined || text === null || text === '') return {};
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Refused('parameters must be JSON, for example {"repo": "node"}');
  }
}

async function run(payload, context, surface, kind) {
  return call(
    { operation: payload?.operation, params: parseParams(payload?.params), caller: context?.principal?.accountId, surface, kind },
    deps,
  );
}

// Automation: a thrown error fails the step; the reason shows in the rule's audit log.
export async function runForAutomation(payload, context) {
  try {
    const result = await run(payload, context, 'automation');
    return { result: JSON.stringify(result) };
  } catch (e) {
    throw new Error(e instanceof Refused ? `Keybroker refused: ${e.message}` : 'Keybroker failed unexpectedly');
  }
}

// Rovo and MCP: a refusal comes back as data so the agent can explain it. Reads and writes are separate tools,
// so a write is declared as one to Rovo and to MCP clients.
async function forAgent(payload, context, kind) {
  try {
    return { result: await run(payload, context, 'agent', kind) };
  } catch (e) {
    return { refused: e instanceof Refused ? e.message : 'unexpected failure' };
  }
}
export const callForAgent = (payload, context) => forAgent(payload, context, 'read');
export const sendForAgent = (payload, context) => forAgent(payload, context, 'write');

// What this caller may use. No credentials, no other callers' access lists.
export async function listForAgent(payload, context) {
  const me = context?.principal?.accountId;
  const [ops, conns] = await Promise.all([store.listOperations(), store.listConnections()]);
  const host = Object.fromEntries(conns.map((c) => [c.id, new URL(c.baseUrl).host]));
  return {
    operations: ops
      .filter((o) => me && o.allowed.includes(me))
      .map((o) => ({ name: o.name, description: o.description, method: o.method, destination: host[o.connectionId] ?? null, params: o.params, returns: o.returns })),
  };
}
