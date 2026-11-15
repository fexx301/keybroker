// Approval requests for agent calls to operations an admin marked "approval required". Pure: no Forge imports.
// A request holds the caller's validated parameters and a snapshot of the operation, never a credential.
// Flow: an agent call is held (pending) -> a Jira admin other than the caller approves (nothing is sent) -> the caller's
// own next identical call releases it, so every check, including Jira visibility, runs as the caller, against the
// approved version of the operation. Decisions and releases are claimed atomically, so each happens at most once.
import { Invalid } from './operations.js';

export const TTL_MS = 24 * 60 * 60 * 1000;

export function newRequest({ id, op, params, caller, kind, now }) {
  return {
    id,
    operation: op.name,
    params,
    caller,
    kind,
    opSnapshot: JSON.stringify(op),
    state: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  };
}

export const isExpired = (req, now) => (req.state === 'pending' || req.state === 'approved') && now > Date.parse(req.expiresAt);

// A refusal that ends the request for good: it can never be approved, so it leaves the queue.
function final(state, message) {
  const e = new Invalid(message);
  e.state = state;
  return e;
}

// Throws Invalid with the reason a decision is not allowed (with .state set when the request is finished for good). Rejecting (or cancelling) your own request is fine;
// approving it is not: approval exists so that a second person signs off.
export function checkDecision(req, { approve, decider, currentOp, now }) {
  if (!req) throw new Invalid('no such request');
  if (req.state !== 'pending') throw new Invalid(`request is already ${req.state}`);
  if (isExpired(req, now)) throw final('expired', 'request expired; the caller must ask again');
  if (!approve) return;
  if (decider === req.caller) throw new Invalid('you cannot approve your own request');
  if (!currentOp || JSON.stringify(currentOp) !== req.opSnapshot) throw final('invalidated', 'the operation changed or was deleted since the request; the caller must ask again');
}

// Decide a request. claim(key) must be atomic (first caller wins): it gives one decision per request.
export async function decide(req, { approve, decider, currentOp, now, claim }) {
  checkDecision(req, { approve, decider, currentOp, now });
  if (!(await claim(`decide:${req.id}`))) throw new Invalid('this request was already decided');
  return { ...req, state: approve ? 'approved' : 'rejected', decidedBy: decider, decidedAt: new Date(now).toISOString() };
}

const sorted = (o) => JSON.stringify(Object.keys(o ?? {}).sort().map((k) => [k, o[k]]));

// The caller's open request for exactly this operation version and these parameters (order-independent), if any.
export function findOpen(reqs, { caller, op, params, now }) {
  const snapshot = JSON.stringify(op);
  const open = reqs.filter((r) => r.caller === caller && r.operation === op.name && r.opSnapshot === snapshot && sorted(r.params) === sorted(params) && !isExpired(r, now));
  return { approved: open.find((r) => r.state === 'approved') ?? null, pending: open.find((r) => r.state === 'pending') ?? null };
}

const NEXT = {
  pending: 'waiting for a Jira admin other than the caller to approve it',
  approved: 'approved: call keybroker-send again with the same operation and parameters to send it',
};

// What the requester (via keybroker-list) and the admin page see.
export function view(req, now) {
  return {
    id: req.id,
    operation: req.operation,
    params: req.params,
    caller: req.caller,
    state: isExpired(req, now) ? 'expired' : req.state,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
    decidedBy: req.decidedBy ?? null,
    result: req.result ?? null,
    reason: req.reason ?? null,
    next: NEXT[isExpired(req, now) ? 'expired' : req.state] ?? null,
  };
}
