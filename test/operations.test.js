import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authHeaders, buildRequest, checkValues, Invalid, pickFields, validateConnection, validateOperation } from '../src/core/operations.js';

const conn = validateConnection({ id: 'github', name: 'GitHub', baseUrl: 'https://api.github.com/', auth: { scheme: 'bearer' } });
const op = validateOperation({
  name: 'open-issues',
  connectionId: 'github',
  method: 'GET',
  path: '/repos/{owner}/{repo}/issues',
  params: { owner: { in: 'path', pattern: '[A-Za-z0-9-]{1,39}' }, repo: { in: 'path', pattern: '[A-Za-z0-9._-]{1,100}' }, state: { in: 'query', pattern: 'open|closed' } },
  returns: ['0.title', '0.number'],
  allowed: ['acct-1'],
});

test('connections: https only, no credentials, query or odd ports', () => {
  assert.equal(conn.baseUrl, 'https://api.github.com');
  for (const baseUrl of ['http://api.github.com', 'https://u:p@api.github.com', 'https://api.github.com?x=1', 'https://api.github.com:8443', 'not a url']) {
    assert.throws(() => validateConnection({ id: 'x1', name: 'x', baseUrl, auth: { scheme: 'bearer' } }), Invalid, baseUrl);
  }
  assert.throws(() => validateConnection({ id: 'x1', name: 'x', baseUrl: 'https://a.example', auth: { scheme: 'header', headerName: 'Host' } }), Invalid);
  assert.throws(() => validateConnection({ id: 'x1', name: 'x', baseUrl: 'https://a.example', auth: { scheme: 'query' } }), Invalid);
});

test('operations: placeholders, methods and paths are checked', () => {
  const base = { name: 'op-a', connectionId: 'github', method: 'GET', returns: ['id'] };
  assert.throws(() => validateOperation({ ...base, path: '/a/{x}' }), /needs a path parameter/);
  assert.throws(() => validateOperation({ ...base, path: '/a', params: { x: { in: 'path', pattern: '.+' } } }), /not used in the path/);
  assert.throws(() => validateOperation({ ...base, path: '/a/../admin' }), Invalid);
  assert.throws(() => validateOperation({ ...base, path: '//evil.example/a' }), Invalid);
  assert.throws(() => validateOperation({ ...base, path: '/a?x=1' }), Invalid);
  assert.throws(() => validateOperation({ ...base, path: '/a', params: { b: { in: 'body', pattern: '.+' } } }), /no body/);
  assert.throws(() => validateOperation({ ...base, path: '/a', returns: [] }), /returned fields/);
  assert.throws(() => validateOperation({ ...base, path: '/a', params: { b: { in: 'query', pattern: '(' } } }), /regular expression/);
  assert.equal(validateOperation({ ...base, path: '/a/{x}', params: { x: { in: 'path', pattern: '.+', required: false } } }).params.x.required, true);
});

test('values: only declared names, text, matching the pattern', () => {
  assert.deepEqual(checkValues(op, { owner: 'fexx301', repo: 'sealed' }), { owner: 'fexx301', repo: 'sealed' });
  assert.throws(() => checkValues(op, { owner: 'fexx301' }), /missing parameter: repo/);
  assert.throws(() => checkValues(op, { owner: 'fexx301', repo: 'sealed', token: 'x' }), /unknown parameter/);
  assert.throws(() => checkValues(op, { owner: 'fexx301', repo: 'sealed', state: 'all' }), /pattern/);
  assert.throws(() => checkValues(op, { owner: 'a/../../admin', repo: 'sealed' }), /pattern/);
  assert.throws(() => checkValues(op, { owner: { $gt: '' }, repo: 'sealed' }), /must be text/);
  assert.throws(() => checkValues(op, ['x']), /must be an object/);
});

test('requests stay on the connection host and path', () => {
  const r = buildRequest(conn, op, { owner: 'fexx301', repo: 'sealed', state: 'open' });
  assert.equal(r.url, 'https://api.github.com/repos/fexx301/sealed/issues?state=open');
  assert.equal(r.method, 'GET');
  assert.equal(r.body, undefined);
  const prefixed = validateConnection({ id: 'svc', name: 'svc', baseUrl: 'https://svc.example/api/v2', auth: { scheme: 'bearer' } });
  const anyPath = validateOperation({ name: 'get-x', connectionId: 'svc', method: 'GET', path: '/{p}', params: { p: { in: 'path', pattern: '.+' } }, returns: ['id'] });
  assert.equal(buildRequest(prefixed, anyPath, { p: '../../admin' }).url, 'https://svc.example/api/v2/..%2F..%2Fadmin');
  const post = validateOperation({ name: 'make', connectionId: 'svc', method: 'POST', path: '/items', params: { title: { in: 'body', pattern: '.{1,80}', required: true } }, returns: ['id'] });
  assert.deepEqual(buildRequest(prefixed, post, { title: 'Hello' }).body, { title: 'Hello' });
});

test('only declared fields come back, as text', () => {
  const data = { id: 7, user: { login: 'femi', token: 'x' }, tags: ['a'], nothing: null };
  assert.deepEqual(pickFields(data, ['id', 'user.login', 'tags', 'nothing', 'missing', 'user.__proto__']), {
    id: '7', 'user.login': 'femi', tags: '["a"]', nothing: null, missing: null, 'user.__proto__': null,
  });
  assert.deepEqual(pickFields([{ title: 't' }], ['0.title']), { '0.title': 't' });
});

test('credentials attach according to the scheme', () => {
  assert.deepEqual(authHeaders(conn, 's3'), { Authorization: 'Bearer s3' });
  assert.deepEqual(authHeaders({ auth: { scheme: 'basic' } }, 'u:p'), { Authorization: 'Basic dTpw' });
  assert.deepEqual(authHeaders({ auth: { scheme: 'header', headerName: 'X-Api-Key' } }, 's3'), { 'X-Api-Key': 's3' });
});
