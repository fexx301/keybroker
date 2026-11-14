// Backend for the admin page. Every function re-checks that the caller is a Jira administrator:
// the page is only shown to admins, but the resolver is the trust boundary.
import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import { Invalid, validateConnection, validateOperation } from './core/operations.js';
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
  if (!(await store.getConnection(connectionId))) throw new Error('No such connection');
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || v.length > 8192) throw new Error('Enter a credential up to 8192 characters');
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

resolver.define('activity', admin(async ({ cursor }) => store.activity(50, cursor)));

export const adminResolver = resolver.getDefinitions();
