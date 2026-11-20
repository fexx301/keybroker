// Converts the admin page's text fields to and from an operation. Validation proper is validateOperation's job.
import { Invalid, JIRA_ISSUE } from './operations.js';

// One parameter per line: "name in pattern", with an optional trailing "optional" for query/body parameters,
// or "name in = value" for a value the admin fixes.
export function parseParamLines(text) {
  const params = {};
  for (const [i, raw] of String(text ?? '').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const fixed = line.match(/^(\S+)\s+(\S+)\s+=\s?(.*)$/); // "name place = value": a value the admin sets
    if (fixed) {
      if (Object.hasOwn(params, fixed[1])) throw new Invalid(`parameter ${fixed[1]} is listed twice`);
      params[fixed[1]] = { in: fixed[2], fixed: fixed[3] };
      continue;
    }
    if (parts.length < 3) throw new Invalid(`parameter line ${i + 1}: write "name in pattern", for example "repo path [a-z0-9-]+"`);
    const optional = parts.length > 3 && parts.at(-1) === 'optional';
    const [name, place, ...rest] = optional ? parts.slice(0, -1) : parts;
    if (Object.hasOwn(params, name)) throw new Invalid(`parameter ${name} is listed twice`);
    params[name] = { in: place, pattern: rest.join(' '), required: !optional };
  }
  return params;
}

export function formatParamLines(params) {
  return Object.entries(params ?? {})
    .map(([name, p]) => (p.fixed !== undefined ? `${name} ${p.in} = ${p.fixed}` : `${name} ${p.in} ${p.pattern}${p.required ? '' : ' optional'}`))
    .join('\n');
}

// The admin page edits parameters as rows. kind: 'pattern' (a regular expression), 'jira' (a work item key the
// caller can see) or 'fixed' (a value the admin sets). Rows without a name are ignored.
export function paramsToRows(params) {
  return Object.entries(params ?? {}).map(([name, p], i) => ({
    id: `r${i}`,
    name,
    in: p.in,
    kind: p.fixed !== undefined ? 'fixed' : p.pattern === JIRA_ISSUE ? 'jira' : 'pattern',
    value: p.fixed ?? (p.pattern === JIRA_ISSUE ? '' : p.pattern),
    required: p.fixed !== undefined || Boolean(p.required),
  }));
}

export function rowsToParams(rows) {
  const params = {};
  for (const r of rows ?? []) {
    const name = String(r.name ?? '').trim();
    if (!name) continue;
    if (Object.hasOwn(params, name)) throw new Invalid(`parameter ${name} is listed twice`);
    params[name] =
      r.kind === 'fixed'
        ? { in: r.in, fixed: r.value ?? '' }
        : { in: r.in, pattern: r.kind === 'jira' ? JIRA_ISSUE : String(r.value ?? '').trim(), required: r.in === 'path' || Boolean(r.required) };
  }
  return params;
}

export const splitList = (text) =>
  String(text ?? '')
    .split(/[,\s]+/)
    .filter(Boolean);

export function toOperation(form) {
  return {
    name: form.name?.trim(),
    description: form.description?.trim() ?? '',
    connectionId: form.connectionId,
    method: form.method,
    path: form.path?.trim(),
    params: Array.isArray(form.params) ? rowsToParams(form.params) : parseParamLines(form.params),
    returns: splitList(form.returns),
    allowed: form.allowed ?? [],
    approval: Boolean(form.approval),
  };
}

// "expires in 21h" / "expires in 35m" for an open approval request; "expired" once the time has passed.
export function expiresIn(expiresAt, now = Date.now()) {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return 'expired';
  const minutes = Math.ceil(ms / 60000);
  return minutes >= 60 ? `expires in ${Math.floor(minutes / 60)}h` : `expires in ${minutes}m`;
}
