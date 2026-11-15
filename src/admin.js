// Backend for the admin page. Every function re-checks that the caller is a Jira administrator:
// the page is only shown to admins, but the resolver is the trust boundary.
import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import { decide, view } from './core/approvals.js';
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

// Template: post to a Slack channel through an incoming webhook. The webhook URL is the secret; the admin pastes it into
// the connection card afterwards. Automation rules post directly; tick approval on the operation to hold agent posts.
resolver.define('slackTemplate', admin(async (_, context) => {
  const conn = validateConnection({ id: 'slack', name: 'Slack', baseUrl: 'https://hooks.slack.com', auth: { scheme: 'url' } });
  const existing = await store.getConnection(conn.id);
  if (existing && (existing.baseUrl !== conn.baseUrl || existing.auth.scheme !== 'url')) throw new Error('A connection named slack already exists with another destination.');
  await store.saveConnection(conn);
  await store.saveOperation(
    validateOperation({
      name: 'slack-post',
      description: 'Post a message to the Slack channel of the stored incoming webhook.',
      connectionId: conn.id,
      method: 'POST',
      path: '/',
      params: { text: { in: 'body', pattern: '[\\s\\S]{1,3000}', required: true } },
      returns: [],
      allowed: [context.accountId],
    }),
  );
  log('template.slack', {});
  return { origin: 'https://hooks.slack.com' };
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

// Approve or reject, as a Jira admin, from this page only (not reachable from any action or MCP tool). Approving sends
// nothing: the caller's own next identical call releases it, so Jira visibility is checked as the caller. One decision
// per request (atomic claim).
resolver.define('decideRequest', admin(async ({ id, approve }, context) => {
  const req = await store.getRequest(String(id ?? ''));
  const decider = context.accountId;
  let decided;
  try {
    decided = await decide(req, { approve: Boolean(approve), decider, currentOp: await store.getOperation(req?.operation ?? ''), now: Date.now(), claim: store.claim });
  } catch (e) {
    // Expired or invalidated: record it so the request leaves the queue instead of failing on every click.
    if (e.state) await store.saveRequest({ ...req, state: e.state, reason: e.message, decidedBy: decider, decidedAt: new Date().toISOString() });
    throw e;
  }
  await store.saveRequest(decided);
  log(approve ? 'request.approved' : 'request.rejected', { id: decided.id, operation: decided.operation });
  return view(decided, Date.now());
}));

resolver.define('activity', admin(async ({ cursor }) => store.activity(50, cursor)));

export const adminResolver = resolver.getDefinitions();
