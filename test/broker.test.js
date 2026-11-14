import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Refused } from '../src/core/broker.js';
import { validateConnection, validateOperation } from '../src/core/operations.js';

const SECRET = 'synthetic-secret-123';
const ME = 'acct-1';
const conn = validateConnection({ id: 'echo', name: 'Echo', baseUrl: 'https://postman-echo.com', auth: { scheme: 'bearer' } });
const ops = {
  'echo-get': validateOperation({
    name: 'echo-get', connectionId: 'echo', method: 'GET', path: '/get',
    params: { q: { in: 'query', pattern: '[a-z]{1,10}' } }, returns: ['args.q', 'url'], allowed: [ME],
  }),
  'echo-headers': validateOperation({
    name: 'echo-headers', connectionId: 'echo', method: 'GET', path: '/get', returns: ['headers'], allowed: [ME],
  }),
};

function deps({ secret = SECRET, response, connection = conn } = {}) {
  const seen = { fetches: [], records: [] };
  return {
    seen,
    now: () => '2026-11-14T00:00:00Z',
    getOperation: async (n) => (Object.hasOwn(ops, n) ? ops[n] : null),
    getConnection: async () => connection,
    getSecret: async () => secret,
    record: async (e) => seen.records.push(e),
    fetch: async (url, init) => {
      seen.fetches.push({ url, init });
      if (response instanceof Error) throw response;
      return response ?? { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ({ args: { q: 'hi' }, url, headers: { authorization: `Bearer ${SECRET}` } }) };
    },
  };
}
const json = (status, body, type = 'application/json') => ({ ok: status < 400, status, headers: new Map([['content-type', type]]), json: async () => body });

test('an allowed call returns only declared fields and is recorded', async () => {
  const d = deps();
  const out = await call({ operation: 'echo-get', params: { q: 'hi' }, caller: ME, surface: 'mcp' }, d);
  assert.deepEqual(out, { 'args.q': 'hi', url: 'https://postman-echo.com/get?q=hi' });
  const init = d.seen.fetches[0].init;
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(init.headers['User-Agent'], 'Keybroker-Forge-app');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(d.seen.records, [{ at: '2026-11-14T00:00:00Z', operation: 'echo-get', caller: ME, surface: 'mcp', outcome: 'allowed', status: 200 }]);
  assert.ok(!JSON.stringify(d.seen.records).includes(SECRET));
});

test('refusals happen before any request and are recorded with a reason', async () => {
  const cases = [
    [{ operation: 'delete-everything', caller: ME }, deps(), /unknown operation/],
    [{ operation: '__proto__', caller: ME }, deps(), /unknown operation/],
    [{ operation: 'echo-get' }, deps(), /no signed-in caller/],
    [{ operation: 'echo-get', caller: 'acct-2' }, deps(), /not allowed/],
    [{ operation: 'echo-get', caller: ME }, deps({ connection: null }), /connection no longer exists/],
    [{ operation: 'echo-get', caller: ME, params: { q: 'HI' } }, deps(), /pattern/],
    [{ operation: 'echo-get', caller: ME, params: { token: 'x' } }, deps(), /unknown parameter/],
    [{ operation: 'echo-get', caller: ME }, deps({ secret: null }), /revoked or never set/],
  ];
  for (const [req, d, reason] of cases) {
    await assert.rejects(call({ surface: 'automation', ...req }, d), (e) => e instanceof Refused && reason.test(e.message));
    assert.equal(d.seen.fetches.length, 0, `${req.operation}: no request`);
    assert.equal(d.seen.records.length, 1);
    assert.equal(d.seen.records[0].outcome, 'refused');
  }
});

test('a declared field that echoes the credential is refused, not returned', async () => {
  const d = deps();
  await assert.rejects(call({ operation: 'echo-headers', caller: ME, surface: 'mcp' }, d), /contained the credential/);
  assert.ok(!JSON.stringify(d.seen.records).includes(SECRET));
});

test('upstream failures never surface the body or the raw error', async () => {
  const leaky = json(401, { echo: SECRET });
  await assert.rejects(call({ operation: 'echo-get', caller: ME }, deps({ response: leaky })), (e) => e.message === 'destination returned 401');
  const thrown = new Error(`connect failed: Authorization: Bearer ${SECRET}`);
  await assert.rejects(call({ operation: 'echo-get', caller: ME }, deps({ response: thrown })), (e) => !e.message.includes(SECRET));
  const notJson = { ok: true, status: 200, headers: new Map(), json: async () => { throw new SyntaxError(SECRET); } };
  await assert.rejects(call({ operation: 'echo-get', caller: ME }, deps({ response: notJson })), (e) => !e.message.includes(SECRET));
  const proxy = json(403, null, 'text/html');
  await assert.rejects(call({ operation: 'echo-get', caller: ME }, deps({ response: proxy })), /admin must approve/);
});
