// What the broker needs from Forge, shared by the agent/Automation entry points and the admin resolver.
import api, { fetch, route } from '@forge/api';
import { findOpen, newRequest } from './core/approvals.js';
import { store } from './store.js';

export const deps = {
  getOperation: store.getOperation,
  getConnection: store.getConnection,
  getSecret: store.getSecret,
  fetch,
  // Asked as the caller, never as the app: Jira answers 404 for work items this user may not browse.
  canSeeIssue: async (key) => {
    const res = await api.asUser().requestJira(route`/rest/api/3/issue/${key}?fields=id`, { headers: { Accept: 'application/json' } });
    return res.status === 200;
  },
  createRequest: async ({ op, params, caller, kind }) => {
    const r = newRequest({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, op, params, caller, kind, now: Date.now() });
    await store.saveRequest(r);
    return r;
  },
  findOpenRequest: async ({ caller, op, params }) => findOpen(await store.listRequests(), { caller, op, params, now: Date.now() }),
  claim: store.claim,
  finishRequest: async (id, patch) => store.saveRequest({ ...(await store.getRequest(id)), ...patch, finishedAt: new Date().toISOString() }),
  now: () => new Date().toISOString(),
  record: async (entry) => {
    console.log(JSON.stringify({ event: `call.${entry.outcome}`, ...entry }));
    await store.record(entry);
  },
};
