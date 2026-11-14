import { invoke, permissions } from '@forge/bridge';
import { EgressType } from '@forge/egress';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  DynamicTable,
  Heading,
  HelperMessage,
  Inline,
  Label,
  Lozenge,
  SectionMessage,
  Select,
  Stack,
  Strong,
  Text,
  TextArea,
  Textfield,
  User,
  UserPicker,
  xcss,
} from '@forge/react';
import React, { useEffect, useState } from 'react';
import { formatParamLines, toOperation } from '../core/form.js';

// Atlassian approves a host once across all of an app's egress groups, so approval is tracked per host.
// Groups are keyed by host; older per-connection groups (sealed-<id>) are still read so earlier approvals count.
// The sealed- prefix predates the rename to Keybroker.
const hostKey = (origin) => `sealed-host-${new URL(origin).host.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
const legacyKey = (id) => `sealed-${id}`;
const originOf = (c) => new URL(c.baseUrl).origin;
const option = (value, label = value) => ({ label, value });
const SCHEMES = [option('bearer', 'Bearer token'), option('header', 'Custom header'), option('basic', 'Basic (user:password)'), option('url', 'Secret URL (webhook)')];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => option(m));
const card = xcss({ borderColor: 'color.border', borderStyle: 'solid', borderWidth: 'border.width', borderRadius: 'border.radius', padding: 'space.200' });

// approvalKeys: the egress groups that approve this connection's host ([] = not approved, null = unknown).
// sharedWith: other connections on the same host, which an approval change also affects.
function ConnectionCard({ c, approvalKeys, sharedWith, act }) {
  const [credential, setCredential] = useState('');
  const host = new URL(c.baseUrl).host;
  const approved = approvalKeys === null ? null : approvalKeys.length > 0;
  const also = sharedWith.length ? ` This also applies to ${sharedWith.join(', ')}.` : '';
  const approve = () =>
    permissions.egress.set({
      egresses: [
        {
          key: hostKey(originOf(c)),
          description: `Keybroker: send requests carrying admin-stored credentials to ${host}.`,
          configured: [{ domain: originOf(c), type: [EgressType.FetchBackendSide] }],
        },
      ],
    });
  const removeApproval = async () => {
    for (const key of approvalKeys ?? []) await permissions.egress.deleteGroup({ key });
  };
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center">
          <Heading as="h4">{c.name}</Heading>
          <Lozenge appearance={c.hasCredential ? 'success' : 'removed'}>{c.hasCredential ? 'credential stored' : 'no credential'}</Lozenge>
          <Lozenge appearance={approved ? 'success' : approved === false ? 'moved' : 'default'}>
            {approved ? 'destination approved' : approved === false ? 'destination not approved' : 'approval status unavailable'}
          </Lozenge>
        </Inline>
        <Text>
          {c.id} · {c.baseUrl} · {SCHEMES.find((s) => s.value === c.auth.scheme)?.label}
          {c.auth.scheme === 'header' ? ` (${c.auth.headerName})` : ''}
        </Text>
        <Label labelFor={`cred-${c.id}`}>{(c.hasCredential ? 'Rotate: new ' : '') + (c.auth.scheme === 'url' ? `secret URL (https://${host}/…)` : 'credential')}</Label>
        <Textfield id={`cred-${c.id}`} type="password" value={credential} onChange={(e) => setCredential(e.target.value)} />
        <HelperMessage>Write-only. Keybroker never shows it again, and rules and agents never receive it.</HelperMessage>
        <ButtonGroup>
          <Button
            appearance="primary"
            isDisabled={!credential.trim()}
            onClick={act(async () => {
              await invoke('setCredential', { connectionId: c.id, value: credential });
              setCredential('');
            }, c.hasCredential ? `Credential for ${c.name} rotated. Rules keep working unchanged.` : `Credential for ${c.name} stored.`)}
          >
            {c.hasCredential ? 'Rotate' : 'Store credential'}
          </Button>
          <Button appearance="warning" isDisabled={!c.hasCredential} onClick={act(() => invoke('revokeCredential', { connectionId: c.id }), `Credential for ${c.name} revoked. The next call is refused.`)}>
            Revoke
          </Button>
          {approved ? (
            <Button onClick={act(removeApproval, `${host} is no longer approved.${also}`)}>Remove approval</Button>
          ) : (
            <Button onClick={act(approve, `${host} approved.${also}`)}>Approve {host}</Button>
          )}
          <Button
            appearance="danger"
            onClick={act(async () => {
              await invoke('deleteConnection', { id: c.id });
              // Keep the host approved while another connection still uses it.
              if (!sharedWith.length) await removeApproval();
            }, `Connection ${c.name} deleted with its credential.`)}
          >
            Delete
          </Button>
        </ButtonGroup>
      </Stack>
    </Box>
  );
}

function NewConnection({ act }) {
  const [f, setF] = useState({ scheme: 'bearer' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () =>
    invoke('saveConnection', {
      connection: { id: f.id?.trim(), name: f.name, baseUrl: f.baseUrl?.trim(), auth: { scheme: f.scheme, headerName: f.headerName?.trim() } },
    });
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Heading as="h4">Add a connection</Heading>
        <Label labelFor="c-name">Name</Label>
        <Textfield id="c-name" onChange={set('name')} placeholder="GitHub" />
        <Label labelFor="c-id">ID</Label>
        <Textfield id="c-id" onChange={set('id')} placeholder="github" />
        <Label labelFor="c-url">Base URL</Label>
        <Textfield id="c-url" onChange={set('baseUrl')} placeholder="https://api.github.com" />
        <HelperMessage>Every operation on this connection stays on this host and path. It cannot be changed later.</HelperMessage>
        <Label labelFor="c-scheme">How the credential is sent</Label>
        <Select inputId="c-scheme" options={SCHEMES} defaultValue={SCHEMES[0]} onChange={(o) => setF({ ...f, scheme: o.value })} />
        {f.scheme === 'header' && (
          <>
            <Label labelFor="c-header">Header name</Label>
            <Textfield id="c-header" onChange={set('headerName')} placeholder="X-Api-Key" />
          </>
        )}
        <Inline>
          <Button appearance="primary" onClick={act(save, 'Connection added. Store its credential and approve its destination next.', true)}>
            Add connection
          </Button>
        </Inline>
      </Stack>
    </Box>
  );
}

function OperationForm({ initial, connections, act, onDone }) {
  const editing = Boolean(initial);
  const [f, setF] = useState(
    initial
      ? { ...initial, params: formatParamLines(initial.params), returns: initial.returns.join(', ') }
      : { method: 'GET', connectionId: connections[0]?.id, allowed: [] },
  );
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const conns = connections.map((c) => option(c.id, c.name));
  const save = () => invoke('saveOperation', { operation: toOperation(f) });
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Heading as="h4">{editing ? `Edit ${initial.name}` : 'Add an operation'}</Heading>
        <Label labelFor="o-name">Name</Label>
        <Textfield id="o-name" defaultValue={f.name} isDisabled={editing} onChange={set('name')} placeholder="open-issues" />
        <HelperMessage>Rules and agents call the operation by this name.</HelperMessage>
        <Label labelFor="o-desc">Description</Label>
        <Textfield id="o-desc" defaultValue={f.description} onChange={set('description')} placeholder="Open issues in one of our repositories" />
        <Label labelFor="o-conn">Connection</Label>
        <Select inputId="o-conn" options={conns} defaultValue={conns.find((o) => o.value === f.connectionId)} onChange={(o) => setF({ ...f, connectionId: o.value })} />
        <Label labelFor="o-method">Method</Label>
        <Select inputId="o-method" options={METHODS} defaultValue={option(f.method)} onChange={(o) => setF({ ...f, method: o.value })} />
        <Label labelFor="o-path">Path</Label>
        <Textfield id="o-path" defaultValue={f.path} onChange={set('path')} placeholder="/repos/acme/{repo}/issues" />
        <Label labelFor="o-params">Parameters, one per line: name, where it goes (path, query or body), allowed pattern, or "= value" to fix it</Label>
        <TextArea id="o-params" defaultValue={f.params} onChange={set('params')} placeholder={'repo path [a-z0-9-]{1,100}\nstate query open|closed optional\nusername body = Keybroker'} />
        <HelperMessage>A value that does not match its whole pattern is refused before any request. Add "optional" to a query or body parameter. A fixed value cannot be supplied or changed by callers. The pattern jira-issue accepts only a work item key the caller can see in Jira.</HelperMessage>
        <Label labelFor="o-returns">Returned fields</Label>
        <Textfield id="o-returns" defaultValue={f.returns} onChange={set('returns')} placeholder="0.title, 0.number" />
        <HelperMessage>Only these fields come back, by dotted path. Leave empty for a write: any 2xx succeeds and callers get only the status.</HelperMessage>
        <UserPicker
          name="o-allowed"
          label="Who may call it"
          isMulti
          defaultValue={f.allowed}
          description="Rules run as their owner; agents and MCP clients run as the signed-in user."
          onChange={(v) => setF({ ...f, allowed: (Array.isArray(v) ? v : v ? [v] : []).map((u) => u.id) })}
        />
        <ButtonGroup>
          <Button appearance="primary" onClick={act(async () => (await save(), onDone()), `Operation ${f.name} saved.`)}>
            {editing ? 'Save changes' : 'Add operation'}
          </Button>
          {editing && <Button onClick={onDone}>Cancel</Button>}
        </ButtonGroup>
      </Stack>
    </Box>
  );
}

// Every call and refusal from every surface, newest first. Entries hold no credential and no response body.
function Activity() {
  const [page, setPage] = useState({ entries: [], nextCursor: null });
  const [error, setError] = useState(null);
  const load = async (cursor) => {
    try {
      const next = await invoke('activity', { cursor });
      setPage((p) => ({ entries: cursor ? [...p.entries, ...next.entries] : next.entries, nextCursor: next.nextCursor }));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const rows = page.entries.map((e, i) => ({
    key: String(i),
    cells: [
      { key: 'at', content: new Date(e.at).toLocaleString() },
      { key: 'op', content: e.operation || '(none)' },
      { key: 'surface', content: e.surface },
      { key: 'caller', content: e.caller ? <User accountId={e.caller} /> : 'nobody signed in' },
      { key: 'outcome', content: <Lozenge appearance={e.outcome === 'allowed' ? 'success' : 'removed'}>{e.outcome}</Lozenge> },
      { key: 'detail', content: e.reason ?? (e.status ? `HTTP ${e.status}` : '') },
    ],
  }));
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Heading as="h2">Activity</Heading>
        <Button onClick={() => load()}>Refresh</Button>
      </Inline>
      {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
      <DynamicTable
        head={{ cells: ['When', 'Operation', 'From', 'Caller', 'Outcome', 'Detail'].map((content, i) => ({ key: String(i), content })) }}
        rows={rows}
        emptyView="No calls yet."
      />
      {page.nextCursor && <Button onClick={() => load(page.nextCursor)}>Load older</Button>}
    </Stack>
  );
}

function Admin() {
  const [data, setData] = useState(null);
  const [approved, setApproved] = useState(new Map());
  const [message, setMessage] = useState(null);
  const [editing, setEditing] = useState(null);
  const [formKey, setFormKey] = useState(0);

  const refresh = async () => {
    const state = await invoke('state');
    setData(state);
    try {
      const keys = [...new Set(state.connections.flatMap((c) => [legacyKey(c.id), hostKey(originOf(c))]))];
      const g = keys.length ? await permissions.egress.get({ keys }) : { results: [] };
      // origin -> keys of the groups that approve it
      const byOrigin = new Map();
      for (const r of g.results) for (const d of r.configured ?? []) byOrigin.set(new URL(d.domain).origin, [...(byOrigin.get(new URL(d.domain).origin) ?? []), r.key]);
      setApproved(byOrigin);
    } catch (e) {
      // Unknown is not the same as "not approved": say so instead of guessing.
      setApproved({ error: e?.message ?? 'unknown error' });
    }
  };
  useEffect(() => {
    refresh().catch((e) => setMessage({ ok: false, text: e.message }));
  }, []);

  // Runs an admin action, reports the outcome and reloads. `reset` clears the add forms.
  const act = (fn, done, reset) => async () => {
    try {
      await fn();
      setMessage({ ok: true, text: done });
      if (reset) setFormKey((k) => k + 1);
      await refresh();
    } catch (e) {
      setMessage({ ok: false, text: e.message });
    }
  };
  const finishEdit = () => {
    setEditing(null);
    setFormKey((k) => k + 1);
  };

  if (!data) return message ? <SectionMessage appearance="error"><Text>{message.text}</Text></SectionMessage> : <Text>Loading…</Text>;
  const connName = Object.fromEntries(data.connections.map((c) => [c.id, c.name]));
  const rows = data.operations.map((o) => ({
    key: o.name,
    cells: [
      { key: 'name', content: <Text><Strong>{o.name}</Strong>{o.description ? ` · ${o.description}` : ''}</Text> },
      { key: 'call', content: `${o.method} ${connName[o.connectionId] ?? o.connectionId} ${o.path}` },
      { key: 'returns', content: o.returns.join(', ') },
      { key: 'allowed', content: o.allowed.length ? `${o.allowed.length} ${o.allowed.length === 1 ? 'person' : 'people'}${o.allowed.includes(data.me) ? ' incl. you' : ''}` : 'nobody' },
      {
        key: 'actions',
        content: (
          <ButtonGroup>
            <Button onClick={() => setEditing(o)}>Edit</Button>
            <Button appearance="danger" onClick={act(() => invoke('deleteOperation', { name: o.name }), `Operation ${o.name} deleted.`)}>
              Delete
            </Button>
          </ButtonGroup>
        ),
      },
    ],
  }));

  return (
    <Stack space="space.300">
      <Text>
        Store a credential once. Automation rules, Rovo agents and MCP clients call the operations below by name; Keybroker adds the credential, makes the
        request and returns only the declared fields.
      </Text>
      {message && (
        <SectionMessage appearance={message.ok ? 'success' : 'error'}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}

      <Heading as="h2">Connections</Heading>
      {data.connections.map((c) => (
        <ConnectionCard
          key={c.id}
          c={c}
          approvalKeys={approved instanceof Map ? approved.get(originOf(c)) ?? [] : null}
          sharedWith={data.connections.filter((o) => o.id !== c.id && originOf(o) === originOf(c)).map((o) => o.name)}
          act={act}
        />
      ))}
      <NewConnection key={`c${formKey}`} act={act} />

      <Heading as="h2">Operations</Heading>
      <DynamicTable
        head={{ cells: ['Operation', 'Request', 'Returns', 'Allowed', ''].map((content, i) => ({ key: String(i), content })) }}
        rows={rows}
        emptyView="No operations yet."
      />
      {data.connections.length ? (
        <OperationForm key={editing ? `e-${editing.name}-${formKey}` : `o${formKey}`} initial={editing} connections={data.connections} act={act} onDone={finishEdit} />
      ) : (
        <Text>Add a connection before defining operations.</Text>
      )}

      <Activity />
    </Stack>
  );
}

ForgeReconciler.render(<Admin />);
