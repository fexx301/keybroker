// Approval requests for agent calls to operations an admin marked "approval required". Pure: no Forge imports.
// A request holds the caller's validated parameters and a snapshot of the operation, never a credential.
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

export const isExpired = (req, now) => req.state === 'pending' && now > Date.parse(req.expiresAt);

// Throws Invalid with the reason a decision is not allowed. Rejecting (or cancelling) your own request is fine;
// approving it is not: approval exists so that a second person signs off.
export function checkDecision(req, { approve, decider, currentOp, now }) {
  if (!req) throw new Invalid('no such request');
  if (req.state !== 'pending') throw new Invalid(`request is already ${req.state}`);
  if (isExpired(req, now)) throw new Invalid('request expired; the caller must ask again');
  if (!approve) return;
  if (decider === req.caller) throw new Invalid('you cannot approve your own request');
  if (!currentOp || JSON.stringify(currentOp) !== req.opSnapshot) throw new Invalid('the operation changed or was deleted since the request; the caller must ask again');
}

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
  };
}
