import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDecision, newRequest, TTL_MS, view } from '../src/core/approvals.js';
import { call } from '../src/core/broker.js';
import { parseParamLines } from '../src/core/form.js';
import { Invalid, validateConnection, validateOperation } from '../src/core/operations.js';

const REQUESTER = 'acct-requester';
const ADMIN = 'acct-admin';
const conn = validateConnection({ id: 'hook', name: 'Hook', baseUrl: 'https://hooks.example.com', auth: { scheme: 'url' } });
const op = validateOperation({
  name: 'notify', connectionId: 'hook', method: 'POST', path: '/', params: parseParamLines('text body .{1,200}\nsource body = Keybroker'),
  returns: [], allowed: [REQUESTER], approval: true,
});

function deps() {
  const seen = { fetches: [], records: [], requests: [] };
  return {
    seen,
    now: () => 'now',
    getOperation: async () => op,
    getConnection: async () => conn,
    getSecret: async () => 'https://hooks.example.com/services/synthetic0hook0token0xyz',
    record: async (e) => seen.records.push(e),
    canSeeIssue: async () => true,
    createRequest: async (r) => (seen.requests.push(r), { id: 'r1', expiresAt: 'later' }),
    fetch: async (url, init) => (seen.fetches.push({ url, init }), { ok: true, status: 200, headers: new Map(), json: async () => ({}) }),
  };
}

test('an agent call to an approval-required operation is held: validated, stored, nothing sent', async () => {
  const d = deps();
  assert.deepEqual(await call({ operation: 'notify', params: { text: 'Deploy 7' }, caller: REQUESTER, surface: 'agent', kind: 'write' }, d), { pending: 'r1', expiresAt: 'later' });
  assert.equal(d.seen.fetches.length, 0);
  assert.deepEqual(d.seen.requests[0].params, { text: 'Deploy 7' }); // fixed values are not stored; they are re-applied when sent
  assert.equal(d.seen.records[0].outcome, 'pending');
  assert.ok(!JSON.stringify(d.seen.requests).includes('synthetic0hook'));
  // Invalid calls are refused before any request is stored.
  await assert.rejects(call({ operation: 'notify', params: { text: '' }, caller: REQUESTER, surface: 'agent', kind: 'write' }, d), /missing parameter/);
  await assert.rejects(call({ operation: 'notify', params: { text: 'x' }, caller: 'someone-else', surface: 'agent', kind: 'write' }, d), /not allowed/);
  assert.equal(d.seen.requests.length, 1);
});

test('Automation runs approval-required operations directly; an approved request is sent with the approver recorded', async () => {
  const d = deps();
  assert.deepEqual(await call({ operation: 'notify', params: { text: 'a' }, caller: REQUESTER, surface: 'automation' }, d), { status: '200' });
  await call({ operation: 'notify', params: { text: 'b' }, caller: REQUESTER, surface: 'agent', kind: 'write', approval: { request: 'r1', by: ADMIN } }, d);
  assert.equal(d.seen.fetches.length, 2);
  assert.deepEqual(JSON.parse(d.seen.fetches[1].init.body), { text: 'b', source: 'Keybroker' });
  assert.equal(d.seen.records[1].approvedBy, ADMIN);
  assert.equal(d.seen.requests.length, 0);
});

test('decisions: no self-approval, no approving a changed operation, an expired or decided request', () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  const req = newRequest({ id: 'r1', op, params: { text: 'x' }, caller: REQUESTER, kind: 'write', now });
  const ok = { approve: true, decider: ADMIN, currentOp: op, now: now + 1000 };
  checkDecision(req, ok);
  assert.throws(() => checkDecision(req, { ...ok, decider: REQUESTER }), /your own request/);
  checkDecision(req, { ...ok, approve: false, decider: REQUESTER }); // cancelling your own request is fine
  assert.throws(() => checkDecision(req, { ...ok, currentOp: { ...op, path: '/other' } }), /operation changed/);
  assert.throws(() => checkDecision(req, { ...ok, currentOp: null }), /operation changed or was deleted/);
  assert.throws(() => checkDecision(req, { ...ok, now: now + TTL_MS + 1 }), /expired/);
  assert.throws(() => checkDecision({ ...req, state: 'sent' }, ok), /already sent/);
  assert.throws(() => checkDecision(null, ok), Invalid);
  assert.equal(view(req, now + TTL_MS + 1).state, 'expired');
});
