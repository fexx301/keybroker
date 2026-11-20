import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expiresIn, formatParamLines, paramsToRows, parseParamLines, rowsToParams, toOperation } from '../src/core/form.js';
import { Invalid, validateOperation } from '../src/core/operations.js';

test('admin form: parameter lines round-trip through a valid operation', () => {
  const op = validateOperation(
    toOperation({
      name: 'open-issues',
      connectionId: 'github',
      method: 'GET',
      path: '/repos/{owner}/{repo}/issues',
      params: 'owner path [A-Za-z0-9-]{1,39}\n\n  repo path [A-Za-z0-9._-]{1,100}\nstate query open|closed optional\n',
      returns: '0.title, 0.number',
      allowed: ['acct-1'],
    }),
  );
  assert.deepEqual(op.params.state, { in: 'query', pattern: 'open|closed', required: false });
  assert.equal(op.params.owner.required, true);
  assert.deepEqual(op.returns, ['0.title', '0.number']);
  assert.deepEqual(parseParamLines(formatParamLines(op.params)), op.params);
});

test('admin form: malformed or duplicate parameter lines are refused', () => {
  assert.throws(() => parseParamLines('repo path'), Invalid);
  assert.throws(() => parseParamLines('a query x\na query y'), Invalid);
});

test('admin form: editor rows round-trip, including Jira work items and fixed values', () => {
  const params = parseParamLines('repo path [a-z0-9-]{1,100}\nticket query jira-issue\nstate query open|closed optional\nsource body = Keybroker');
  const rows = paramsToRows(params);
  assert.deepEqual(rows.map((r) => r.kind), ['pattern', 'jira', 'pattern', 'fixed']);
  assert.deepEqual(rowsToParams(rows), params);
  assert.deepEqual(rowsToParams([...rows, { id: 'x', name: '  ', in: 'query', kind: 'pattern', value: '' }]), params); // blank rows ignored
  assert.throws(() => rowsToParams([rows[0], { ...rows[0], id: 'dup' }]), Invalid);
  const op = validateOperation(toOperation({ name: 'rows-op', connectionId: 'c1', method: 'POST', path: '/repos/{repo}', params: rows, returns: '', allowed: [] }));
  assert.equal(op.params.ticket.pattern, 'jira-issue');
});

test('approval expiry text: hours, minutes, then expired', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(expiresIn('2026-11-21T07:30:00Z', now), 'expires in 21h');
  assert.equal(expiresIn('2026-11-20T10:35:00Z', now), 'expires in 35m');
  assert.equal(expiresIn('2026-11-20T10:00:20Z', now), 'expires in 1m');
  assert.equal(expiresIn('2026-11-20T09:59:00Z', now), 'expired');
  assert.equal(expiresIn('not a date', now), 'expired');
});
