// Forge storage for connections, operations, credentials and the activity log.
import { kvs, WhereConditions } from '@forge/kvs';

const CONN = 'conn:';
const OP = 'op:';
const ACT = 'act:';
const REQ = 'req:';
const credKey = (connectionId) => `credential:${connectionId}`;

async function all(prefix) {
  const out = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export const store = {
  getConnection: (id) => kvs.get(CONN + id),
  listConnections: () => all(CONN),
  saveConnection: (c) => kvs.set(CONN + c.id, c),
  deleteConnection: async (id) => {
    await kvs.deleteSecret(credKey(id));
    await kvs.delete(CONN + id);
  },

  getOperation: (name) => kvs.get(OP + name),
  listOperations: () => all(OP),
  saveOperation: (o) => kvs.set(OP + o.name, o),
  deleteOperation: (name) => kvs.delete(OP + name),

  // The value is only ever read by the broker; nothing returns it to a page, rule or agent.
  getSecret: (connectionId) => kvs.getSecret(credKey(connectionId)),
  hasSecret: async (connectionId) => Boolean(await kvs.getSecret(credKey(connectionId))),
  setSecret: (connectionId, value) => kvs.setSecret(credKey(connectionId), value),
  deleteSecret: (connectionId) => kvs.deleteSecret(credKey(connectionId)),

  getRequest: (id) => kvs.get(REQ + id),
  saveRequest: (r) => kvs.set(REQ + r.id, r),
  // shortcut: reads every request and sorts in memory; fine for hundreds, page by key if volume grows.
  listRequests: async () => (await all(REQ)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),

  // Keys sort oldest-last so a prefix query returns the newest entries first.
  record: async (entry) => {
    const inverted = String(9e15 - Date.now()).padStart(16, '0');
    await kvs.set(`${ACT}${inverted}:${Math.random().toString(36).slice(2, 8)}`, entry);
  },
  activity: async (limit = 50, cursor) => {
    let q = kvs.query().where('key', WhereConditions.beginsWith(ACT)).limit(Math.min(limit, 100));
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    return { entries: page.results.map((r) => r.value), nextCursor: page.nextCursor ?? null };
  },
};
