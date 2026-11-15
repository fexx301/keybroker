import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../src/core/broker.js';
import { buildRequest, Invalid, validateConnection, validateOperation } from '../src/core/operations.js';

// Regressions for the 2026-11-15 review, findings 1 and 5.
const conn = validateConnection({ id: 'api', name: 'API', baseUrl: 'https://test.example/api', auth: { scheme: 'basic' } });
const op = (path, params) => validateOperation({ name: 'op-x', connectionId: 'api', method: 'GET', path, params, returns: ['headers.authorization'], allowed: ['me'] });
const any = { in: 'path', pattern: '.{1,50}' };

test('path values cannot move the request to another route, alone or combined', () => {
  assert.throws(() => buildRequest(conn, op('/tenants/{t}/records', { t: any }), { t: '..' }), /change the request path/);
  assert.throws(() => buildRequest(conn, op('/tenants/{t}/records', { t: any }), { t: '.' }), /change the request path/);
  assert.throws(() => buildRequest(conn, op('/a/{x}{y}/b', { x: any, y: any }), { x: '.', y: '.' }), /change the request path/);
  assert.throws(() => buildRequest(conn, op('/a/{x}./b', { x: any }), { x: '.' }), /change the request path/);
  const hook = validateConnection({ id: 'hook', name: 'Hook', baseUrl: 'https://hooks.example.com', auth: { scheme: 'url' } });
  const hookOp = validateOperation({ name: 'post-x', connectionId: 'hook', method: 'POST', path: '/{x}', params: { x: any }, returns: [], allowed: [] });
  assert.throws(() => buildRequest(hook, hookOp, { x: '..' }, 'https://hooks.example.com/services/T/B/synthetic'), /change the request path/);
  // Ordinary values, encoded, still pass and stay inside their segment.
  assert.equal(buildRequest(conn, op('/tenants/{t}/records', { t: any }), { t: 'a b/é' }).url, 'https://test.example/api/tenants/a%20b%2F%C3%A9/records');
  assert.equal(buildRequest(conn, op('/tenants/{t}/records', { t: any }), { t: '...' }).url, 'https://test.example/api/tenants/.../records');
});

test('a Basic-auth echo is refused: the base64 wire form counts as the credential', async () => {
  const secret = 'synthetic-user:synthetic-password';
  const d = {
    now: () => 'now', getOperation: async () => op('/x', {}), getConnection: async () => conn, getSecret: async () => secret, record: async () => {},
    fetch: async (url, init) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ headers: { authorization: init.headers.Authorization } }) }),
  };
  await assert.rejects(call({ operation: 'op-x', caller: 'me', surface: 'agent', kind: 'read' }, d), /contained the credential/);
  const bare = { ...d, fetch: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ headers: { authorization: Buffer.from(secret).toString('base64') } }) }) };
  await assert.rejects(call({ operation: 'op-x', caller: 'me', surface: 'agent', kind: 'read' }, bare), /contained the credential/);
  assert.ok(Invalid);
});
