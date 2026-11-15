import { view } from './core/approvals.js';
import { call, Refused } from './core/broker.js';
import { deps } from './deps.js';
import { store } from './store.js';

export { adminResolver } from './admin.js';


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
    const result = await run(payload, context, 'agent', kind);
    if (result?.pending) {
      return {
        pending: {
          request: result.pending,
          expiresAt: result.expiresAt,
          note: `Nothing was sent${result.existing ? '; this request was already waiting' : ''}. A Jira admin other than you must approve it in Jira settings > Apps > Keybroker. Once keybroker-list shows it approved, call keybroker-send again with the same operation and parameters: that call sends it.`,
        },
      };
    }
    return { result };
  } catch (e) {
    return { refused: e instanceof Refused ? e.message : 'unexpected failure' };
  }
}
export const callForAgent = (payload, context) => forAgent(payload, context, 'read');
export const sendForAgent = (payload, context) => forAgent(payload, context, 'write');

// What this caller may use. No credentials, no other callers' access lists.
export async function listForAgent(payload, context) {
  const me = context?.principal?.accountId;
  const [ops, conns, reqs] = await Promise.all([store.listOperations(), store.listConnections(), store.listRequests()]);
  const host = Object.fromEntries(conns.map((c) => [c.id, new URL(c.baseUrl).host]));
  return {
    operations: ops
      .filter((o) => me && o.allowed.includes(me))
      .map((o) => ({ name: o.name, description: o.description, method: o.method, destination: host[o.connectionId] ?? null, params: o.params, returns: o.returns, needsApproval: o.approval })),
    // This caller's own approval requests, newest first, so an agent can report what happened.
    myRequests: reqs.filter((r) => me && r.caller === me).slice(0, 10).map((r) => view(r, Date.now())),
  };
}
