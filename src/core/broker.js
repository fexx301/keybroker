// The call path every surface (Automation, Rovo, MCP) goes through. No Forge imports: storage and fetch are injected.
import { authHeaders, buildRequest, Invalid, JIRA_ISSUE, pickFields, secretFragments } from './operations.js';

export class Refused extends Error {}

// deps: { getOperation(name), getConnection(id), getSecret(connectionId), fetch(url, init), record(entry), now(),
//         canSeeIssue(key): true only if Jira, asked as the caller, returns the work item }
// kind: 'read' or 'write' restricts an agent tool to GET or non-GET operations; omitted (Automation) allows both.
export async function call({ operation, params, caller, surface, kind }, deps) {
  const entry = { at: deps.now(), operation: String(operation ?? '').slice(0, 48), caller: caller ?? null, surface };
  const refuse = async (reason, extra = {}, outcome = 'refused') => {
    await deps.record({ ...entry, outcome, reason, ...extra });
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
    return refuse('destination unreachable or not approved by an admin');
  }
  // The upstream body is never included in errors: it can echo the credential.
  if (res.status === 403 && !res.headers?.get?.('content-type')?.includes('json')) {
    return refuse('destination refused the request (if this host is new, an admin must approve it)', { status: 403 });
  }
  if (!res.ok) return refuse(`destination returned ${res.status}`, { status: res.status });
  // A write declares no fields: any 2xx is success and the body is never read (webhooks often answer with text or nothing).
  if (!op.returns.length) {
    await deps.record({ ...entry, outcome: 'allowed', status: res.status });
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
  return result;
}
