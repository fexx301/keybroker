// Converts the admin page's text fields to and from an operation. Validation proper is validateOperation's job.
import { Invalid } from './operations.js';

// One parameter per line: "name in pattern", with an optional trailing "optional" for query/body parameters.
export function parseParamLines(text) {
  const params = {};
  for (const [i, raw] of String(text ?? '').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
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
    .map(([name, p]) => `${name} ${p.in} ${p.pattern}${p.required ? '' : ' optional'}`)
    .join('\n');
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
    params: parseParamLines(form.params),
    returns: splitList(form.returns),
    allowed: form.allowed ?? [],
  };
}
