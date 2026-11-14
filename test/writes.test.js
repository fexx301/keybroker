import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../src/core/broker.js';
import { parseParamLines, formatParamLines } from '../src/core/form.js';
import { buildRequest, checkSecret, Invalid, validateConnection, validateOperation } from '../src/core/operations.js';

const ME = 'acct-1';
const HOOK = 'https://hooks.example.com/services/T000/B000/synthetic0hook0token0xyz';
const hookConn = validateConnection({ id: 'slack', name: 'Slack', baseUrl: 'https://hooks.example.com', auth: { scheme: 'url' } });
const notify = validateOperation({
  name: 'notify', connectionId: 'slack', method: 'POST', path: '/',
  params: parseParamLines('text body .{1,200}\nusername body = Keybroker'), returns: [], allowed: [ME],
});

function deps(response, { secret = HOOK, op = notify, connection = hookConn } = {}) {
  const seen = { fetches: [], records: [] };
  return {
    seen,
    now: () => 'now',
    getOperation: async () => op,
    getConnection: async () => connection,
    getSecret: async () => secret,
    record: async (e) => seen.records.push(e),
    fetch: async (url, init) => (seen.fetches.push({ url, init }), response),
  };
}
const res = (status, body, type) => ({ ok: status < 400, status, headers: new Map(type ? [['content-type', type]] : []), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

test('a write with no declared fields succeeds on any 2xx without reading the body', async () => {
  const d = deps(res(200, 'ok', 'text/plain'));
  assert.deepEqual(await call({ operation: 'notify', params: { text: 'Deploy done' }, caller: ME }, d), { status: '200' });
  const [{ url, init }] = d.seen.fetches;
  assert.equal(url, HOOK);
  assert.deepEqual(JSON.parse(init.body), { text: 'Deploy done', username: 'Keybroker' });
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(d.seen.records[0].outcome, 'allowed');
  assert.ok(!JSON.stringify(d.seen.records).includes('synthetic0hook'));
});

test('fixed values cannot be supplied or overridden by the caller', async () => {
  const d = deps(res(204));
  await assert.rejects(call({ operation: 'notify', params: { text: 'hi', username: 'Mallory' }, caller: ME }, d), /set by the admin/);
  assert.equal(d.seen.fetches.length, 0);
  assert.equal(formatParamLines(notify.params), 'text body .{1,200}\nusername body = Keybroker');
});

test('a secret URL must stay on the connection host, and its query cannot be overwritten', () => {
  assert.throws(() => checkSecret(hookConn, 'https://evil.example.net/services/x'), /must be on hooks.example.com/);
  assert.throws(() => checkSecret(hookConn, 'http://hooks.example.com/x'), /https/);
  const teams = validateConnection({ id: 'teams', name: 'Teams', baseUrl: 'https://prod.logic.example.com', auth: { scheme: 'url' } });
  const op = validateOperation({ name: 'post', connectionId: 'teams', method: 'POST', path: '/', params: { sig: { in: 'query', pattern: '.*' } }, returns: [], allowed: [ME] });
  const secret = 'https://prod.logic.example.com/workflows/abc/invoke/?api-version=1&sig=synthetic0signature0value';
  assert.throws(() => buildRequest(teams, op, { sig: 'x' }, secret), /overwrite part of the secret URL/);
  const ok = buildRequest(teams, { ...op, params: {} }, {}, secret);
  assert.equal(ok.url, 'https://prod.logic.example.com/workflows/abc/invoke?api-version=1&sig=synthetic0signature0value');
});

test('a declared field echoing part of a secret URL is refused', async () => {
  const echo = validateOperation({ name: 'echo', connectionId: 'slack', method: 'POST', path: '/', params: {}, returns: ['url'], allowed: [ME] });
  const d = deps(res(200, { url: '/services/T000/B000/synthetic0hook0token0xyz' }, 'application/json'), { op: echo });
  await assert.rejects(call({ operation: 'echo', caller: ME }, d), /contained the credential/);
});

test('a read whose 2xx response is not JSON is reported as failed after sending, not as refused', async () => {
  const read = validateOperation({ name: 'read', connectionId: 'slack', method: 'GET', path: '/', params: {}, returns: ['a'], allowed: [ME] });
  const d = deps(res(200, 'not json', 'text/plain'), { op: read });
  await assert.rejects(call({ operation: 'read', caller: ME }, d), /was sent \(HTTP 200\) but the response was not JSON/);
  assert.equal(d.seen.records[0].outcome, 'failed');
  assert.throws(() => validateOperation({ name: 'x1', connectionId: 'slack', method: 'POST', path: '/{a}', params: parseParamLines('a path = x'), returns: [], allowed: [] }), Invalid);
});

test('agent tools are split: reads cannot send writes and writes cannot read', async () => {
  const d = deps(res(200));
  await assert.rejects(call({ operation: 'notify', params: { text: 'x' }, caller: ME, kind: 'read' }, d), /changes data; use keybroker-send/);
  const read = validateOperation({ name: 'read', connectionId: 'slack', method: 'GET', path: '/', params: {}, returns: ['a'], allowed: [ME] });
  await assert.rejects(call({ operation: 'read', caller: ME, kind: 'write' }, deps(res(200), { op: read })), /only reads; use keybroker-call/);
  assert.equal(d.seen.fetches.length, 0);
});
