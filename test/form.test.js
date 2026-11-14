import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatParamLines, parseParamLines, toOperation } from '../src/core/form.js';
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
