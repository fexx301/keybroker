// Backend for the admin page. Every function re-checks that the caller is a Jira administrator:
// the page is only shown to admins, but the resolver is the trust boundary.
import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import { checkDecision, view } from './core/approvals.js';
import { call, Refused } from './core/broker.js';
import { checkSecret, Invalid, validateConnection, validateOperation } from './core/operations.js';
import { deps } from './deps.js';
import { store } from './store.js';

async function requireAdmin() {
  const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, {
    headers: { Accept: 'application/json' },
  });
  const body = res.ok ? await res.json() : null;
  if (body?.permissions?.ADMINISTER?.havePermission !== true) throw new Error('Jira administrator permission is required');
}

function admin(fn) {
  return async (req) => {
    await requireAdmin();
    try {
      return await fn(req.payload ?? {}, req.context);
    } catch (e) {
      if (e instanceof Invalid) throw new Error(e.message);
      throw e;
    }
  };
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

const resolver = new Resolver();

resolver.define('state', admin(async (_, context) => {
  const [connections, operations] = await Promise.all([store.listConnections(), store.listOperations()]);
  const withCred = await Promise.all(connections.map(async (c) => ({ ...c, hasCredential: await store.hasSecret(c.id) })));
  return { connections: withCred, operations, me: context.accountId };
}));

resolver.define('saveConnection', admin(async ({ connection }) => {
  const c = validateConnection(connection);
  const existing = await store.getConnection(c.id);
  // Moving a connection to another host would hand its credential to that host: make the admin start again instead.
  if (existing && existing.baseUrl !== c.baseUrl) throw new Error('A connection cannot change destination. Create a new connection.');
  await store.saveConnection(c);
  log('connection.saved', { id: c.id, host: new URL(c.baseUrl).host });
  return c;
}));

resolver.define('deleteConnection', admin(async ({ id }) => {
  const users = (await store.listOperations()).filter((o) => o.connectionId === id).map((o) => o.name);
  if (users.length) throw new Error(`Delete the operations that use it first: ${users.join(', ')}`);
  await store.deleteConnection(id);
  log('connection.deleted', { id });
  return true;
}));

resolver.define('setCredential', admin(async ({ connectionId, value }) => {
  const conn = await store.getConnection(connectionId);
  if (!conn) throw new Error('No such connection');
  const v = typeof value === 'string' ? value.trim() : '';
  checkSecret(conn, v); // a secret URL must be https on the connection's host
  await store.setSecret(connectionId, v);
  log('credential.set', { connectionId });
  return true;
}));

resolver.define('revokeCredential', admin(async ({ connectionId }) => {
  await store.deleteSecret(connectionId);
  log('credential.revoked', { connectionId });
  return true;
}));

resolver.define('saveOperation', admin(async ({ operation }) => {
  const o = validateOperation(operation);
  if (!(await store.getConnection(o.connectionId))) throw new Error('No such connection');
  await store.saveOperation(o);
  log('operation.saved', { name: o.name, connectionId: o.connectionId, allowed: o.allowed.length });
  return o;
}));

resolver.define('deleteOperation', admin(async ({ name }) => {
  await store.deleteOperation(name);
  log('operation.deleted', { name });
  return true;
}));

// One click for a first look: a connection to Postman Echo (a public test endpoint that echoes requests), an obviously
// fake credential, and an operation whose parameter must be a Jira work item the caller can see. Safe to repeat.
resolver.define('sampleSetup', admin(async (_, context) => {
  const conn = validateConnection({ id: 'sample-echo', name: 'Sample: Postman Echo', baseUrl: 'https://postman-echo.com', auth: { scheme: 'bearer' } });
  const existing = await store.getConnection(conn.id);
  if (existing && existing.baseUrl !== conn.baseUrl) throw new Error('A connection named sample-echo already exists with another destination.');
  await store.saveConnection(conn);
  if (!(await store.hasSecret(conn.id))) await store.setSecret(conn.id, 'keybroker-sample-not-a-secret');
  await store.saveOperation(
    validateOperation({
      name: 'sample-echo',
      description: 'Sample: echoes a work item key you can see. Postman Echo is a public test endpoint.',
      connectionId: conn.id,
      method: 'GET',
      path: '/get',
      params: { ticket: { in: 'query', pattern: 'jira-issue', required: true } },
      returns: ['args.ticket', 'url'],
      allowed: [context.accountId],
    }),
  );
  log('sample.created', {});
  return { origin: 'https://postman-echo.com' };
}));

// Test an operation as the signed-in admin, through the same broker path rules and agents use (allow-list included).
resolver.define('testOperation', admin(async ({ name, params }, context) => {
  try {
    return { result: await call({ operation: name, params, caller: context.accountId, surface: 'admin test' }, deps) };
  } catch (e) {
    if (e instanceof Refused) return { refused: e.message };
    throw e;
  }
}));

resolver.define('requests', admin(async () => (await store.listRequests()).slice(0, 50).map((r) => view(r, Date.now()))));

// The only way to release a pending request: a Jira admin, from this page. Not reachable from any action or MCP tool.
// Approving runs the whole broker path again, as the original caller; jira-issue parameters are re-checked as the approver.
resolver.define('decideRequest', admin(async ({ id, approve }, context) => {
  const req = await store.getRequest(String(id ?? ''));
  const decider = context.accountId;
  try {
    checkDecision(req, { approve: Boolean(approve), decider, currentOp: await store.getOperation(req?.operation ?? ''), now: Date.now() });
  } catch (e) {
    // Expired or invalidated: record it so the request leaves the queue instead of failing on every click.
    if (e.state) await store.saveRequest({ ...req, state: e.state, reason: e.message, decidedBy: decider, decidedAt: new Date().toISOString() });
    throw e;
  }
  // shortcut: no compare-and-set in KVS; marking before sending narrows, but does not close, a double-approve race.
  await store.saveRequest({ ...req, state: approve ? 'sending' : 'rejected', decidedBy: decider, decidedAt: new Date().toISOString() });
  log(approve ? 'request.approved' : 'request.rejected', { id: req.id, operation: req.operation });
  if (!approve) return view({ ...req, state: 'rejected', decidedBy: decider }, Date.now());
  let done;
  try {
    const result = await call({ operation: req.operation, params: req.params, caller: req.caller, surface: 'agent', kind: req.kind, approval: { request: req.id, by: decider } }, deps);
    done = { ...req, state: 'sent', decidedBy: decider, result };
  } catch (e) {
    done = { ...req, state: 'failed', decidedBy: decider, reason: e instanceof Refused ? e.message : 'unexpected failure' };
  }
  await store.saveRequest(done);
  return view(done, Date.now());
}));

resolver.define('activity', admin(async ({ cursor }) => store.activity(50, cursor)));

export const adminResolver = resolver.getDefinitions();
