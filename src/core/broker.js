// The call path every surface (Automation, Rovo, MCP) goes through. No Forge imports: storage and fetch are injected.
import { authHeaders, buildRequest, checkValues, Invalid, JIRA_ISSUE, pickFields, secretFragments } from './operations.js';

export class Refused extends Error {}

// deps: { getOperation(name), getConnection(id), getSecret(connectionId), fetch(url, init), record(entry), now(),
//         canSeeIssue(key): true only if Jira, asked as the caller, returns the work item,
//         createRequest({ op, params, caller, kind }): stores a pending approval request, returns { id, expiresAt },
//         findOpenRequest({ caller, op, params }): { approved, pending } for this exact call (see approvals.findOpen),
//         claim(key): atomic, true only for the first caller, finishRequest(id, patch) }
// kind: 'read' or 'write' restricts an agent tool to GET or non-GET operations; omitted (Automation) allows both.
export async function call({ operation, params, caller, surface, kind }, deps) {
  const entry = { at: deps.now(), operation: String(operation ?? '').slice(0, 48), caller: caller ?? null, surface };
  let release = null; // an approved request this call is sending
  let noResponse = false; // the request may have reached the destination without a response
  const refuse = async (reason, extra = {}, outcome = 'refused') => {
    await deps.record({ ...entry, outcome, reason, ...extra });
    // After the release claim every outcome is final: nothing is retried, so a request is sent at most once.
    if (release) await deps.finishRequest(release.id, { state: noResponse ? 'unknown' : 'failed', reason });
    throw new Refused(reason);
  };

  const op = typeof operation === 'string' ? await deps.getOperation(operation) : null;
  if (!op) return refuse('unknown operation');
  if (!caller) return refuse('no signed-in caller');
  if (!op.allowed.includes(caller)) return refuse('caller is not allowed to use this operation');
  if (kind === 'read' && op.method !== 'GET') return refuse(`${op.name} changes data; use keybroker-send`);
  if (kind === 'write' && op.method === 'GET') return refuse(`${op.name} only reads; use keybroker-call`);
  const conn = await deps.getConnection(op.connectionId);
  if (!conn) return refuse('the operation\'s connection no longer exists');

  let req;
  try {
    req = buildRequest(conn, op, params);
  } catch (e) {
    if (e instanceof Invalid) return refuse(e.message);
    throw e;
  }
  // Jira-bound parameters: Jira's own permissions decide which work items this caller may name. Fail closed.
  for (const [name, spec] of Object.entries(op.params)) {
    const key = params?.[name];
    if (spec.pattern !== JIRA_ISSUE || key === undefined || key === null || key === '') continue;
    let visible = false;
    try {
      visible = (await deps.canSeeIssue(String(key))) === true;
    } catch {
      return refuse(`could not confirm that the caller can see ${key}`);
    }
    if (!visible) return refuse(`caller cannot see work item ${key}`);
  }
  // Approval required: everything above has been checked, as this caller, against this one read of the operation.
  if (op.approval && surface === 'agent') {
    const supplied = Object.fromEntries(Object.entries(checkValues(op, params)).filter(([n]) => op.params[n].fixed === undefined));
    const open = await deps.findOpenRequest({ caller, op, params: supplied });
    if (!open.approved) {
      if (open.pending) return { pending: open.pending.id, expiresAt: open.pending.expiresAt, existing: true };
      const req = await deps.createRequest({ op, params: supplied, caller, kind });
      await deps.record({ ...entry, outcome: 'pending', reason: `waiting for approval (request ${req.id})`, request: req.id });
      return { pending: req.id, expiresAt: req.expiresAt };
    }
    // The caller's own call releases the approved request (same operation version, same parameters). Claimed once.
    if (!(await deps.claim(`release:${open.approved.id}`))) return refuse(`request ${open.approved.id} is already being sent or was sent`);
    release = open.approved;
    Object.assign(entry, { request: release.id, approvedBy: release.decidedBy });
  }
  const secret = await deps.getSecret(conn.id);
  if (!secret) return refuse('no credential stored for this connection (revoked or never set)');
  if (conn.auth.scheme === 'url') {
    try {
      req = buildRequest(conn, op, params, secret);
    } catch (e) {
      if (e instanceof Invalid) return refuse('the stored secret URL no longer fits this connection; an admin must store it again');
      throw e;
    }
  }

  let res;
  try {
    res = await deps.fetch(req.url, {
      method: req.method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Keybroker-Forge-app', // some APIs (GitHub) refuse requests without one
        ...(req.body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(conn, secret),
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
      redirect: 'error', // a redirect could carry the credential to another host
    });
  } catch {
    // Never forward the raw error: it can quote the request, headers included.
    noResponse = Boolean(release);
    return refuse(release ? 'no response from the destination; the request may have been sent and will not be retried' : 'destination unreachable or not approved by an admin');
  }
  // The upstream body is never included in errors: it can echo the credential.
  if (res.status === 403 && !res.headers?.get?.('content-type')?.includes('json')) {
    return refuse('destination refused the request (if this host is new, an admin must approve it)', { status: 403 });
  }
  if (!res.ok) return refuse(`destination returned ${res.status}`, { status: res.status });
  // A write declares no fields: any 2xx is success and the body is never read (webhooks often answer with text or nothing).
  if (!op.returns.length) {
    await deps.record({ ...entry, outcome: 'allowed', status: res.status });
    if (release) await deps.finishRequest(release.id, { state: 'sent', result: { status: String(res.status) } });
    return { status: String(res.status) };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return refuse(`the request was sent (HTTP ${res.status}) but the response was not JSON, so no declared field could be read`, { status: res.status }, 'failed');
  }
  const result = pickFields(data, op.returns);
  // Extra layer, not the guarantee: the declared fields are. Refuse rather than return a value carrying the credential.
  const fragments = secretFragments(conn, secret);
  if (Object.values(result).some((v) => typeof v === 'string' && fragments.some((f) => v.includes(f)))) {
    return refuse('a declared field contained the credential; nothing was returned', { status: res.status });
  }
  await deps.record({ ...entry, outcome: 'allowed', status: res.status });
  if (release) await deps.finishRequest(release.id, { state: 'sent', result });
  return result;
}
