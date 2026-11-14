// Validation and request building for connections and operations. No Forge imports: pure and testable.

export class Invalid extends Error {}

const NAME = /^[a-z][a-z0-9-]{1,47}$/;
const PARAM = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'content-length', 'transfer-encoding', 'connection']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SCHEMES = new Set(['bearer', 'header', 'basic']);
const PLACES = new Set(['path', 'query', 'body']);
const MAX_VALUE = 1000;

function need(cond, msg) {
  if (!cond) throw new Invalid(msg);
}

// A connection is where requests go and how the credential is attached. The credential itself is stored separately.
export function validateConnection(c) {
  need(c && typeof c === 'object', 'connection must be an object');
  need(NAME.test(c.id ?? ''), 'connection id: lowercase letters, digits and dashes, 2-48 characters');
  need(typeof c.name === 'string' && c.name.trim().length > 0 && c.name.length <= 80, 'connection name: 1-80 characters');
  let u;
  try {
    u = new URL(c.baseUrl);
  } catch {
    throw new Invalid('base URL is not a valid URL');
  }
  need(u.protocol === 'https:', 'base URL must use https');
  need(!u.username && !u.password, 'base URL must not contain credentials');
  need(!u.search && !u.hash, 'base URL must not contain a query or fragment');
  need(!u.port || u.port === '443', 'base URL must use the default https port');
  const auth = c.auth ?? {};
  need(SCHEMES.has(auth.scheme), 'auth scheme must be bearer, header or basic');
  if (auth.scheme === 'header') {
    need(HEADER.test(auth.headerName ?? ''), 'header name: letters, digits and dashes');
    need(!FORBIDDEN_HEADERS.has(auth.headerName.toLowerCase()), `header ${auth.headerName} cannot carry a credential`);
  }
  return {
    id: c.id,
    name: c.name.trim(),
    baseUrl: u.origin + u.pathname.replace(/\/+$/, ''),
    auth: auth.scheme === 'header' ? { scheme: 'header', headerName: auth.headerName } : { scheme: auth.scheme },
  };
}

function compilePattern(p) {
  need(typeof p === 'string' && p.length > 0 && p.length <= 200, 'parameter pattern: 1-200 characters');
  try {
    return new RegExp(`^(?:${p})$`);
  } catch {
    throw new Invalid(`parameter pattern is not a valid regular expression: ${p}`);
  }
}

// An operation is one pinned request: method, path, the parameters a caller may supply, and the fields that may come back.
export function validateOperation(o) {
  need(o && typeof o === 'object', 'operation must be an object');
  need(NAME.test(o.name ?? ''), 'operation name: lowercase letters, digits and dashes, 2-48 characters');
  need(NAME.test(o.connectionId ?? ''), 'operation must name a connection');
  need(METHODS.has(o.method), 'method must be GET, POST, PUT, PATCH or DELETE');
  need(typeof o.path === 'string' && o.path.startsWith('/') && o.path.length <= 300, 'path must start with / and be at most 300 characters');
  need(!/\.\.|\/\/|[?#\\\s]/.test(o.path), 'path must not contain .., //, ?, #, backslashes or spaces');
  const params = o.params ?? {};
  need(typeof params === 'object' && !Array.isArray(params), 'params must be an object');
  const clean = {};
  for (const [name, spec] of Object.entries(params)) {
    need(PARAM.test(name), `parameter name ${name}: letters, digits and underscores`);
    need(PLACES.has(spec?.in), `parameter ${name}: "in" must be path, query or body`);
    need(!(spec.in === 'body' && o.method === 'GET'), `parameter ${name}: GET requests have no body`);
    compilePattern(spec.pattern);
    clean[name] = { in: spec.in, pattern: spec.pattern, required: spec.in === 'path' ? true : Boolean(spec.required) };
  }
  const placeholders = [...o.path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  for (const ph of placeholders) need(clean[ph]?.in === 'path', `path placeholder {${ph}} needs a path parameter`);
  for (const [name, spec] of Object.entries(clean)) {
    if (spec.in === 'path') need(placeholders.includes(name), `path parameter ${name} is not used in the path`);
  }
  const literal = o.path.replace(/\{[^}]*\}/g, '');
  need(/^[A-Za-z0-9\-._~/:@!$&'()*+,;=]*$/.test(literal), 'path contains characters that must be percent-encoded');
  const returns = o.returns ?? [];
  need(Array.isArray(returns) && returns.length > 0 && returns.length <= 20, 'declare 1-20 returned fields');
  for (const r of returns) need(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(r), `returned field ${r}: dotted names only`);
  const allowed = o.allowed ?? [];
  need(Array.isArray(allowed) && allowed.every((a) => /^[\w:-]{1,128}$/.test(a)), 'allowed must be a list of account IDs');
  return {
    name: o.name,
    description: typeof o.description === 'string' ? o.description.slice(0, 300) : '',
    connectionId: o.connectionId,
    method: o.method,
    path: o.path,
    params: clean,
    returns: [...new Set(returns)],
    allowed: [...new Set(allowed)],
  };
}

// Caller-supplied values are untrusted: only declared names, strings, within their pattern.
export function checkValues(op, values) {
  need(values === undefined || (values && typeof values === 'object' && !Array.isArray(values)), 'parameters must be an object');
  const v = values ?? {};
  for (const name of Object.keys(v)) need(Object.hasOwn(op.params, name), `unknown parameter: ${name.slice(0, 40)}`);
  const out = {};
  for (const [name, spec] of Object.entries(op.params)) {
    const has = Object.hasOwn(v, name) && v[name] !== '' && v[name] !== null && v[name] !== undefined;
    if (!has) {
      need(!spec.required, `missing parameter: ${name}`);
      continue;
    }
    const value = typeof v[name] === 'number' || typeof v[name] === 'boolean' ? String(v[name]) : v[name];
    need(typeof value === 'string' && value.length <= MAX_VALUE, `parameter ${name} must be text up to ${MAX_VALUE} characters`);
    need(compilePattern(spec.pattern).test(value), `parameter ${name} does not match its allowed pattern`);
    out[name] = value;
  }
  return out;
}

// Build the request. The final URL is checked against the connection so no value can move it to another host or path.
export function buildRequest(conn, op, values) {
  const v = checkValues(op, values);
  const path = op.path.replace(/\{([^}]*)\}/g, (_, name) => encodeURIComponent(v[name]));
  const url = new URL(conn.baseUrl + path);
  const body = {};
  for (const [name, spec] of Object.entries(op.params)) {
    if (!Object.hasOwn(v, name)) continue;
    if (spec.in === 'query') url.searchParams.set(name, v[name]);
    if (spec.in === 'body') body[name] = v[name];
  }
  const base = new URL(conn.baseUrl);
  need(url.origin === base.origin, 'request would leave the connection host');
  need(url.pathname === base.pathname || url.pathname.startsWith(base.pathname.replace(/\/?$/, '/')), 'request would leave the connection path');
  return { url: url.toString(), method: op.method, body: Object.keys(body).length ? body : undefined };
}

// Only declared fields come back, as text. Objects and arrays are returned as JSON text.
export function pickFields(data, fields) {
  const out = {};
  for (const f of fields) {
    let cur = data;
    for (const part of f.split('.')) cur = cur !== null && typeof cur === 'object' && Object.hasOwn(cur, part) ? cur[part] : undefined;
    out[f] = cur === undefined || cur === null ? null : typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
  }
  return out;
}

export function authHeaders(conn, secret) {
  if (conn.auth.scheme === 'bearer') return { Authorization: `Bearer ${secret}` };
  if (conn.auth.scheme === 'basic') return { Authorization: `Basic ${Buffer.from(secret).toString('base64')}` };
  return { [conn.auth.headerName]: secret };
}
