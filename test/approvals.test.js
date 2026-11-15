import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDecision, decide, findOpen, newRequest, TTL_MS, view } from '../src/core/approvals.js';
import { call } from '../src/core/broker.js';
import { parseParamLines } from '../src/core/form.js';
import { Invalid, validateConnection, validateOperation } from '../src/core/operations.js';

const REQUESTER = 'acct-requester';
const ADMIN = 'acct-admin';
const conn = validateConnection({ id: 'hook', name: 'Hook', baseUrl: 'https://hooks.example.com', auth: { scheme: 'url' } });
const op = validateOperation({
  name: 'notify', connectionId: 'hook', method: 'POST', path: '/', params: parseParamLines('text body .{1,200}\nticket body jira-issue optional\nsource body = Keybroker'),
  returns: [], allowed: [REQUESTER], approval: true,
});

// A fake world: requests in memory, an atomic claim (check-and-add before any await), a visibility table per caller.
function world({ fetchThrows = false, visible = () => true } = {}) {
  const requests = [];
  const claims = new Set();
  const seen = { fetches: [], records: [], visibility: [] };
  let n = 0;
  const deps = (caller) => ({
    now: () => 'now',
    getOperation: async () => op,
    getConnection: async () => conn,
    getSecret: async () => 'https://hooks.example.com/services/synthetic0hook0token0xyz',
    record: async (e) => seen.records.push(e),
    canSeeIssue: async (key) => (seen.visibility.push([caller, key]), visible(caller, key)),
    createRequest: async ({ op: o, params, caller: c, kind }) => {
      const r = newRequest({ id: `r${++n}`, op: o, params, caller: c, kind, now: Date.now() });
      requests.push(r);
      return r;
    },
    findOpenRequest: async (q) => findOpen(requests, { ...q, now: Date.now() }),
    claim: async (key) => (claims.has(key) ? false : (claims.add(key), true)),
    finishRequest: async (id, patch) => Object.assign(requests.find((r) => r.id === id), patch),
    fetch: async (url, init) => {
      seen.fetches.push({ url, init });
      if (fetchThrows) throw new Error('socket hang up');
      return { ok: true, status: 200, headers: new Map(), json: async () => ({}) };
    },
  });
  const send = (params, caller = REQUESTER) => call({ operation: 'notify', params, caller, surface: 'agent', kind: 'write' }, deps(caller));
  const approve = async (id, decider = ADMIN) => {
    const r = requests.find((x) => x.id === id);
    Object.assign(r, await decide(r, { approve: true, decider, currentOp: op, now: Date.now(), claim: deps(decider).claim }));
  };
  return { requests, seen, send, approve, deps };
}

test('held, then approved (nothing sent), then released once by the requester own identical call', async () => {
  const w = world();
  const first = await w.send({ text: 'Deploy 7' });
  assert.equal(first.pending, 'r1');
  assert.equal((await w.send({ text: 'Deploy 7' })).existing, true); // no duplicate request while pending
  assert.equal(w.requests.length, 1);
  await w.approve('r1');
  assert.equal(w.seen.fetches.length, 0); // approving sends nothing
  assert.deepEqual(await w.send({ text: 'Deploy 7' }), { status: '200' });
  assert.equal(w.seen.fetches.length, 1);
  assert.deepEqual(JSON.parse(w.seen.fetches[0].init.body), { text: 'Deploy 7', source: 'Keybroker' });
  assert.equal(w.requests[0].state, 'sent');
  assert.equal(w.seen.records.at(-1).approvedBy, ADMIN);
  // Sent requests are not reusable: the same call again starts a new request.
  assert.ok((await w.send({ text: 'Deploy 7' })).pending);
  assert.equal(w.seen.fetches.length, 1);
});

test('review finding 2: Jira visibility is checked as the requester at release, not as the approver', async () => {
  let requesterCanSee = true;
  const w = world({ visible: (caller) => caller === REQUESTER && requesterCanSee });
  await w.send({ text: 'x', ticket: 'SEC-1' });
  await w.approve('r1');
  requesterCanSee = false; // access lost after the request was made
  await assert.rejects(w.send({ text: 'x', ticket: 'SEC-1' }), /cannot see work item SEC-1/);
  assert.equal(w.seen.fetches.length, 0);
  assert.ok(w.seen.visibility.every(([caller]) => caller === REQUESTER));
});

test('review finding 3: concurrent releases send once; concurrent decisions have one winner', async () => {
  const w = world();
  await w.send({ text: 'once' });
  await w.approve('r1');
  const results = await Promise.allSettled([w.send({ text: 'once' }), w.send({ text: 'once' })]);
  assert.equal(w.seen.fetches.length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  const r2 = newRequest({ id: 'd1', op, params: { text: 'y' }, caller: REQUESTER, kind: 'write', now: Date.now() });
  const claim = w.deps(ADMIN).claim;
  const decisions = await Promise.allSettled([
    decide(r2, { approve: true, decider: ADMIN, currentOp: op, now: Date.now(), claim }),
    decide(r2, { approve: false, decider: 'acct-other-admin', currentOp: op, now: Date.now(), claim }),
  ]);
  assert.equal(decisions.filter((d) => d.status === 'fulfilled').length, 1);
});

test('review finding 4: an operation edited after approval is not released; the approved version is what runs', async () => {
  const w = world();
  await w.send({ text: 'v1' });
  await w.approve('r1');
  const edited = { ...op, path: '/different-write' };
  const out = await call({ operation: 'notify', params: { text: 'v1' }, caller: REQUESTER, surface: 'agent', kind: 'write' }, { ...w.deps(REQUESTER), getOperation: async () => edited });
  assert.ok(out.pending); // a fresh request for the new version, not a release of the old approval
  assert.equal(w.seen.fetches.length, 0);
});

test('no response after the release claim: marked unknown and never retried', async () => {
  const w = world({ fetchThrows: true });
  await w.send({ text: 'maybe' });
  await w.approve('r1');
  await assert.rejects(w.send({ text: 'maybe' }), /may have been sent and will not be retried/);
  assert.equal(w.requests[0].state, 'unknown');
  assert.equal(w.seen.fetches.length, 1);
});

test('decisions: no self-approval, no approving a changed operation, an expired or decided request', async () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  const req = newRequest({ id: 'r1', op, params: { text: 'x' }, caller: REQUESTER, kind: 'write', now });
  const ok = { approve: true, decider: ADMIN, currentOp: op, now: now + 1000 };
  checkDecision(req, ok);
  assert.throws(() => checkDecision(req, { ...ok, decider: REQUESTER }), /your own request/);
  checkDecision(req, { ...ok, approve: false, decider: REQUESTER }); // cancelling your own request is fine
  assert.throws(() => checkDecision(req, { ...ok, currentOp: { ...op, path: '/other' } }), (e) => e.state === 'invalidated');
  assert.throws(() => checkDecision(req, { ...ok, currentOp: null }), /operation changed or was deleted/);
  assert.throws(() => checkDecision(req, { ...ok, now: now + TTL_MS + 1 }), (e) => e.state === 'expired');
  assert.throws(() => checkDecision({ ...req, state: 'sent' }, ok), /already sent/);
  assert.throws(() => checkDecision(null, ok), Invalid);
  assert.equal(view(req, now + TTL_MS + 1).state, 'expired');
  assert.equal(view({ ...req, state: 'approved' }, now + TTL_MS + 1).state, 'expired'); // approved but unsent also expires
  assert.match(view({ ...req, state: 'approved' }, now).next, /call keybroker-send again/);
  // Given the current operations, an open request for a changed or deleted operation shows as invalidated.
  assert.equal(view({ ...req, state: 'approved' }, now, [op]).state, 'approved');
  assert.equal(view({ ...req, state: 'approved' }, now, [{ ...op, path: '/other' }]).state, 'invalidated');
  assert.equal(view(req, now, []).next, null);
  assert.equal(view({ ...req, state: 'sent' }, now, []).state, 'sent'); // history is left as it was
});

test('Automation runs approval-required operations directly', async () => {
  const w = world();
  assert.deepEqual(await call({ operation: 'notify', params: { text: 'a' }, caller: REQUESTER, surface: 'automation' }, w.deps(REQUESTER)), { status: '200' });
  assert.equal(w.requests.length, 0);
});
