import { invoke, permissions } from '@forge/bridge';
import { EgressType } from '@forge/egress';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Code,
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
  Textfield,
  User,
  UserPicker,
  xcss,
} from '@forge/react';
import React, { useEffect, useState } from 'react';
import { paramsToRows, toOperation } from '../core/form.js';

// Atlassian approves a host once across all of an app's egress groups, so approval is tracked per host.
// Groups are keyed by host; older per-connection groups (sealed-<id>) are still read so earlier approvals count.
// The sealed- prefix predates the rename to Keybroker.
const hostKey = (origin) => `sealed-host-${new URL(origin).host.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
const legacyKey = (id) => `sealed-${id}`;
const originOf = (c) => new URL(c.baseUrl).origin;
const option = (value, label = value) => ({ label, value });
// Forge prefixes resolver errors; show only Keybroker's own reason.
const reason = (e) => String(e?.message ?? e).replace(/^There was an error invoking the function - /, '');
const SCHEMES = [option('bearer', 'Bearer token'), option('header', 'Custom header'), option('basic', 'Basic (user:password)'), option('url', 'Secret URL (webhook)')];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => option(m));
const approveHost = (origin) =>
  permissions.egress.set({
    egresses: [
      {
        key: hostKey(origin),
        description: `Keybroker: send requests carrying admin-stored credentials to ${new URL(origin).host}.`,
        configured: [{ domain: origin, type: [EgressType.FetchBackendSide] }],
      },
    ],
  });
const PLACES = ['query', 'path', 'body'].map((p) => option(p));
const KINDS = [option('pattern', 'Text matching a pattern'), option('jira', 'A Jira work item the caller can see'), option('fixed', 'A fixed value you set')];
const card = xcss({ borderColor: 'color.border', borderStyle: 'solid', borderWidth: 'border.width', borderRadius: 'border.radius', padding: 'space.200' });

// approvalKeys: the egress groups that approve this connection's host ([] = not approved, null = unknown).
// sharedWith: other connections on the same host, which an approval change also affects.
function ConnectionCard({ c, approvalKeys, sharedWith, act }) {
  const [credential, setCredential] = useState('');
  const host = new URL(c.baseUrl).host;
  const approved = approvalKeys === null ? null : approvalKeys.length > 0;
  const also = sharedWith.length ? ` This also applies to ${sharedWith.join(', ')}.` : '';
  const approve = () => approveHost(originOf(c));
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

// One row per parameter: its name, where it goes, what it accepts. Callers can supply only these.
function ParamEditor({ rows, onChange }) {
  const update = (id, patch) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <Stack space="space.100">
      {rows.map((r) => (
        <Box key={r.id} xcss={card}>
          <Inline space="space.150" alignBlock="end" shouldWrap>
            <Stack>
              <Label labelFor={`p-name-${r.id}`}>Name</Label>
              <Textfield id={`p-name-${r.id}`} defaultValue={r.name} placeholder="repo" onChange={(e) => update(r.id, { name: e.target.value })} />
            </Stack>
            <Stack>
              <Label labelFor={`p-in-${r.id}`}>Goes in</Label>
              <Select inputId={`p-in-${r.id}`} options={PLACES} defaultValue={option(r.in)} onChange={(o) => update(r.id, { in: o.value })} />
            </Stack>
            <Stack>
              <Label labelFor={`p-kind-${r.id}`}>Accepts</Label>
              <Select inputId={`p-kind-${r.id}`} options={KINDS} defaultValue={KINDS.find((k) => k.value === r.kind)} onChange={(o) => update(r.id, { kind: o.value })} />
            </Stack>
            {r.kind !== 'jira' && (
              <Stack>
                <Label labelFor={`p-val-${r.id}`}>{r.kind === 'fixed' ? 'Value' : 'Pattern (regular expression)'}</Label>
                <Textfield id={`p-val-${r.id}`} defaultValue={r.value} placeholder={r.kind === 'fixed' ? 'Keybroker' : '[a-z0-9-]{1,100}'} onChange={(e) => update(r.id, { value: e.target.value })} />
              </Stack>
            )}
            {r.in !== 'path' && r.kind !== 'fixed' && (
              <Checkbox name={`p-req-${r.id}`} label="Required" defaultChecked={r.required} onChange={(e) => update(r.id, { required: e.target.checked })} />
            )}
            <Button appearance="subtle" onClick={() => onChange(rows.filter((x) => x.id !== r.id))}>
              Remove
            </Button>
          </Inline>
        </Box>
      ))}
      <Inline>
        <Button onClick={() => onChange([...rows, { id: `n${Date.now()}`, name: '', in: 'query', kind: 'pattern', value: '', required: true }])}>Add parameter</Button>
      </Inline>
    </Stack>
  );
}

// Runs one operation as you, through the same path rules and agents use, and shows exactly what comes back.
function TestPanel({ op, onClose, onRan }) {
  const fields = Object.entries(op.params).filter(([, p]) => p.fixed === undefined);
  const [values, setValues] = useState({});
  const [outcome, setOutcome] = useState(null);
  const run = async () => {
    try {
      setOutcome(await invoke('testOperation', { name: op.name, params: values }));
    } catch (e) {
      setOutcome({ refused: reason(e) });
    }
    onRan();
  };
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Heading as="h4">Test {op.name}</Heading>
        <Text>Runs as you, with the same checks a rule or agent gets. {op.method === 'GET' ? '' : 'This is a write: the request is really sent.'}</Text>
        {fields.map(([name, p]) => (
          <Stack key={name}>
            <Label labelFor={`t-${name}`}>{name}</Label>
            <Textfield id={`t-${name}`} placeholder={p.pattern === 'jira-issue' ? 'A work item key, e.g. MOBL-57' : p.pattern} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
          </Stack>
        ))}
        {!fields.length && <Text>This operation takes no parameters.</Text>}
        <ButtonGroup>
          <Button appearance="primary" onClick={run}>Run test</Button>
          <Button onClick={onClose}>Close</Button>
        </ButtonGroup>
        {outcome?.result && (
          <SectionMessage appearance="success" title="Returned (only the declared fields)">
            <Code>{JSON.stringify(outcome.result)}</Code>
          </SectionMessage>
        )}
        {outcome?.refused && (
          <SectionMessage appearance="warning" title="Refused">
            <Text>{outcome.refused}</Text>
          </SectionMessage>
        )}
      </Stack>
    </Box>
  );
}

function OperationForm({ initial, connections, act, onDone }) {
  const editing = Boolean(initial);
  const [f, setF] = useState(
    initial
      ? { ...initial, params: paramsToRows(initial.params), returns: initial.returns.join(', ') }
      : { method: 'GET', connectionId: connections[0]?.id, allowed: [], params: [] },
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
        <Label labelFor="o-params">Parameters callers may supply</Label>
        <ParamEditor rows={f.params} onChange={(params) => setF({ ...f, params })} />
        <HelperMessage>
          Anything that does not match is refused before a request is made. Use {'{name}'} in the path for a path parameter. A Jira work item is checked as the caller, so Jira's own permissions decide what they may name. Fixed values cannot be supplied or changed by callers.
        </HelperMessage>
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
        <Checkbox
          name="o-approval"
          label="Agent calls wait for approval by a Jira admin other than the caller"
          defaultChecked={Boolean(f.approval)}
          onChange={(e) => setF({ ...f, approval: e.target.checked })}
        />
        <HelperMessage>Rovo and MCP calls are checked, then held until approved here; nothing is sent before that. Automation rules run directly.</HelperMessage>
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

// Agent calls held for approval. Approving sends nothing: the caller's own next identical call sends it, with every
// check run as them. You cannot approve your own request. The page shows the state the backend returns.
function Approvals({ me, version }) {
  const [reqs, setReqs] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [history, setHistory] = useState(false);
  const load = () => invoke('requests').then(setReqs, (e) => setError(reason(e)));
  useEffect(() => {
    load();
  }, [version]);
  const OUTCOME = {
    approved: (r) => `Request ${r.id} approved. Nothing has been sent: it goes out when the requester sends it again.`,
    rejected: (r) => `Request ${r.id} rejected. Nothing was sent.`,
  };
  const decide = (id, approve) => async () => {
    try {
      const r = await invoke('decideRequest', { id, approve });
      setNote({ ok: Boolean(OUTCOME[r.state]), text: (OUTCOME[r.state] ?? ((x) => `Request ${x.id} is ${x.state}${x.reason ? `: ${x.reason}` : ''}.`))(r) });
    } catch (e) {
      setNote({ ok: false, text: reason(e) });
    }
    await load();
  };
  const pending = (reqs ?? []).filter((r) => r.state === 'pending');
  const open = (r) => r.state === 'pending' || r.state === 'approved';
  const rows = (reqs ?? []).filter((r) => history || open(r)).slice(0, 15).map((r) => ({
    key: r.id,
    cells: [
      { key: 'op', content: <Text><Strong>{r.operation}</Strong> · {r.id}</Text> },
      { key: 'params', content: <Code>{JSON.stringify(r.params)}</Code> },
      { key: 'caller', content: <User accountId={r.caller} /> },
      { key: 'state', content: <Lozenge appearance={{ pending: 'moved', approved: 'inprogress', sent: 'success', rejected: 'removed', failed: 'removed', unknown: 'removed' }[r.state] ?? 'default'}>{r.state}</Lozenge> },
      {
        key: 'actions',
        content:
          r.state === 'pending' ? (
            <ButtonGroup>
              <Button appearance="primary" isDisabled={r.caller === me} onClick={decide(r.id, true)}>
                Approve
              </Button>
              <Button onClick={decide(r.id, false)}>Reject</Button>
            </ButtonGroup>
          ) : r.state === 'approved' ? (
            <Text>Waiting for the requester to send it</Text>
          ) : (
            <Text>{r.reason ?? (r.result ? JSON.stringify(r.result) : '')}</Text>
          ),
      },
    ],
  }));
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Heading as="h2">Waiting for approval{pending.length ? ` (${pending.length})` : ''}</Heading>
        <Button onClick={load}>Refresh</Button>
        <Button appearance="subtle" onClick={() => setHistory(!history)}>{history ? 'Hide history' : 'Show history'}</Button>
      </Inline>
      {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
      {note && <SectionMessage appearance={note.ok ? 'success' : 'warning'}><Text>{note.text}</Text></SectionMessage>}
      {pending.some((r) => r.caller === me) && <Text>You cannot approve your own requests; another Jira admin must.</Text>}
      <DynamicTable
        head={{ cells: ['Request', 'Parameters', 'Requested by', 'State', ''].map((content, i) => ({ key: String(i), content })) }}
        rows={rows}
        emptyView={history ? 'No requests.' : 'Nothing is waiting for approval.'}
      />
    </Stack>
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
      setError(reason(e));
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
      {
        key: 'detail',
        content: e.approvedBy ? (
          <Inline space="space.050" alignBlock="center">
            <Text>{e.reason ?? `HTTP ${e.status}`} · approved by</Text>
            <User accountId={e.approvedBy} />
          </Inline>
        ) : (e.reason ?? (e.status ? `HTTP ${e.status}` : '')),
      },
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
  const [testing, setTesting] = useState(null);
  const [activityKey, setActivityKey] = useState(0);
  const [formKey, setFormKey] = useState(0);

  const refresh = async () => {
    const state = await invoke('state');
    setData(state);
    try {
      const keys = [...new Set(state.connections.flatMap((c) => [legacyKey(c.id), hostKey(originOf(c))]))];
      // Multi-key lookups proved unreliable on the demo site (approved hosts came back missing while calls to them
      // worked), so ask for one key at a time.
      // Also read the whole list, page by page: an approval can live under the key of a deleted connection that shared
      // the host, which a lookup by current keys would miss.
      const g = { results: (await Promise.all(keys.map((key) => permissions.egress.get({ keys: [key] })))).flatMap((r) => r.results ?? []) };
      let token;
      do {
        const page = await permissions.egress.get(token ? { nextPageToken: token } : {});
        g.results.push(...(page.results ?? []));
        token = page.lastEvaluatedKey;
      } while (token);
      // origin -> keys of the groups that approve it
      const byOrigin = new Map();
      for (const r of g.results) for (const d of r.configured ?? []) byOrigin.set(new URL(d.domain).origin, [...new Set([...(byOrigin.get(new URL(d.domain).origin) ?? []), r.key])]);
      setApproved(byOrigin);
    } catch (e) {
      // Unknown is not the same as "not approved": say so instead of guessing.
      setApproved({ error: e?.message ?? 'unknown error' });
    }
  };
  useEffect(() => {
    refresh().catch((e) => setMessage({ ok: false, text: reason(e) }));
  }, []);

  // Runs an admin action, reports the outcome and reloads. `reset` clears the add forms.
  const act = (fn, done, reset) => async () => {
    try {
      await fn();
      setMessage({ ok: true, text: done });
      if (reset) setFormKey((k) => k + 1);
      await refresh();
    } catch (e) {
      setMessage({ ok: false, text: reason(e) });
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
      { key: 'allowed', content: (o.allowed.length ? `${o.allowed.length} ${o.allowed.length === 1 ? 'person' : 'people'}${o.allowed.includes(data.me) ? ' incl. you' : ''}` : 'nobody') + (o.approval ? ' · agents need approval' : '') },
      {
        key: 'actions',
        content: (
          <ButtonGroup>
            <Button onClick={() => setTesting(o)}>Test</Button>
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

      {!data.connections.some((c) => c.id === 'sample-echo') && (
        <SectionMessage appearance="discovery" title={data.connections.length ? 'Want a quick example?' : 'New to Keybroker? Start with a sample'}>
          <Text>
            Adds a connection to Postman Echo (a public test endpoint), a fake credential and an operation that accepts only a Jira work item you can see.
            Atlassian asks you to approve postman-echo.com; then press Test on sample-echo.
          </Text>
          <Inline>
            <Button
              appearance="primary"
              onClick={act(async () => {
                const { origin } = await invoke('sampleSetup');
                // Atlassian approves a host once; asking again for an approved host fails.
                if (!(approved instanceof Map && approved.has(origin))) await approveHost(origin);
              }, 'Sample added. Press Test on sample-echo and enter a work item key you can see, then one you cannot.')}
            >
              Add the sample
            </Button>
          </Inline>
        </SectionMessage>
      )}

      {approved?.error && (
        <SectionMessage appearance="warning">
          <Text>Atlassian did not return destination approvals ({approved.error}). Calls still use the real approvals; reload to try again.</Text>
        </SectionMessage>
      )}
            <Inline space="space.150" alignBlock="center">
        <Heading as="h2">Connections</Heading>
        {!data.connections.some((c) => c.id === 'slack') && (
          <Button
            onClick={act(async () => {
              const { origin } = await invoke('slackTemplate');
              if (!(approved instanceof Map && approved.has(origin))) await approveHost(origin);
            }, 'Slack added. Paste your incoming-webhook URL into the Slack card and store it, then Test slack-post.')}
          >
            Add Slack (incoming webhook)
          </Button>
        )}
      </Inline>
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
      {testing && <TestPanel key={testing.name} op={testing} onClose={() => setTesting(null)} onRan={() => setActivityKey((k) => k + 1)} />}
      {data.connections.length ? (
        <OperationForm key={editing ? `e-${editing.name}-${formKey}` : `o${formKey}`} initial={editing} connections={data.connections} act={act} onDone={finishEdit} />
      ) : (
        <Text>Add a connection before defining operations.</Text>
      )}

      <Approvals me={data.me} version={formKey} />

      <Activity key={activityKey} />
    </Stack>
  );
}

ForgeReconciler.render(<Admin />);
