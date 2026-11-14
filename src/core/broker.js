// The call path every surface (Automation, Rovo, MCP) goes through. No Forge imports: storage and fetch are injected.
import { authHeaders, buildRequest, Invalid, pickFields } from './operations.js';

export class Refused extends Error {}

// deps: { getOperation(name), getConnection(id), getSecret(connectionId), fetch(url, init), record(entry), now() }
export async function call({ operation, params, caller, surface }, deps) {
  const entry = { at: deps.now(), operation: String(operation ?? '').slice(0, 48), caller: caller ?? null, surface };
  const refuse = async (reason, extra = {}) => {
    await deps.record({ ...entry, outcome: 'refused', reason, ...extra });
    throw new Refused(reason);
  };

  const op = typeof operation === 'string' ? await deps.getOperation(operation) : null;
  if (!op) return refuse('unknown operation');
  if (!caller) return refuse('no signed-in caller');
  if (!op.allowed.includes(caller)) return refuse('caller is not allowed to use this operation');
  const conn = await deps.getConnection(op.connectionId);
  if (!conn) return refuse('the operation\'s connection no longer exists');

  let req;
  try {
    req = buildRequest(conn, op, params);
  } catch (e) {
    if (e instanceof Invalid) return refuse(e.message);
    throw e;
  }
  const secret = await deps.getSecret(conn.id);
  if (!secret) return refuse('no credential stored for this connection (revoked or never set)');

  let res;
  try {
    res = await deps.fetch(req.url, {
      method: req.method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Sealed-Forge-app', // some APIs (GitHub) refuse requests without one
        ...(req.body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(conn, secret),
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
      redirect: 'error', // a redirect could carry the credential to another host
    });
  } catch {
    // Never forward the raw error: it can quote the request, headers included.
    return refuse('destination unreachable or not approved by an admin');
  }
  // The upstream body is never included in errors: it can echo the credential.
  if (res.status === 403 && !res.headers?.get?.('content-type')?.includes('json')) {
    return refuse('destination refused the request (if this host is new, an admin must approve it)', { status: 403 });
  }
  if (!res.ok) return refuse(`destination returned ${res.status}`, { status: res.status });
  let data;
  try {
    data = await res.json();
  } catch {
    return refuse('destination returned a non-JSON body', { status: res.status });
  }
  const result = pickFields(data, op.returns);
  // Extra layer, not the guarantee: the declared fields are. Refuse rather than return a value carrying the credential.
  if (Object.values(result).some((v) => typeof v === 'string' && v.includes(secret))) {
    return refuse('a declared field contained the credential; nothing was returned', { status: res.status });
  }
  await deps.record({ ...entry, outcome: 'allowed', status: res.status });
  return result;
}
