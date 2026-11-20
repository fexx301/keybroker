<img src="assets/keybroker.png" alt="" width="96" align="left">

# Keybroker

**Store an integration credential once. Let Jira Automation rules, Rovo agents and MCP clients call named operations with it, without any of them ever receiving it.**

A Forge app for Jira, built for Codegeist 2026.

- Install link: *added at submission*
- Demo video: *added at submission*

## The problem

Teams connect Jira to outside services with API tokens. Today that token goes in one of two places:

- **A Jira Automation "Send web request" step, as a hidden header.** It has to be typed into every rule that needs it and again after every copy or import, so rotating one token means editing every rule. Atlassian's docs warn that anyone who can edit the rule can point the request somewhere else. The request for real secret storage, [AUTO-1365](https://jira.atlassian.com/browse/AUTO-1365), is still open.
- **A Marketplace vault that hands the secret back to the rule.** The rule still holds the value; only the hiding place moves.

AI agents make this worse. An agent that needs an outside API either gets no access or gets the token in its context.

## What Keybroker does

An admin adds a **connection** (a destination and how the credential is attached: bearer token, custom header, basic auth, or a **secret webhook URL** for Slack, Teams, Discord or Zapier) and stores the credential once. The admin then defines **operations**: a method, a path, the parameters a caller may supply (each with where it goes and a pattern its value must match, a value the admin fixes, or `jira-issue`: a work item key the caller can see in Jira), the fields that may come back (none, for a write), and who may call it.

A rule, an agent or an MCP client calls an operation **by name**. Keybroker then:

1. checks that the caller, taken from Forge's invocation context, is on that operation's allow-list;
   for a `jira-issue` parameter, asks Jira **as the caller** whether they can see that work item, so Jira's own permissions decide which outside records a rule or agent may touch;
2. checks every parameter against its pattern and builds the request; the final URL must stay on the connection's host and path;
3. attaches the credential, makes the request, and refuses redirects;
4. returns **only the declared fields**, and refuses if one of them contains the credential;
5. records the call or refusal, with its reason, in an activity log.

An operation can also require **approval for agent calls**: a Rovo or MCP call is fully checked, then held as a pending request (validated parameters only, no credential, nothing sent). A Jira admin *other than the caller* approves it on the admin page, and approving sends nothing: the **caller's own next identical call releases it**, so every check, including Jira visibility, runs as the caller, against the exact operation version that was approved. Decisions and releases are claimed atomically, so each happens at most once; after the release claim nothing is retried. A changed operation, or 24 hours, ends the request. (Rovo's own review card only asks the same user to confirm, and MCP clients get no confirmation at all.)

Rotating or revoking happens in one place. No rule changes.

The caller proposes; Keybroker's code decides.

## Surfaces

| Surface | Module | What the caller gets |
|---|---|---|
| Jira Automation | `action` + `automation:actionProvider` | A "Keybroker call" step; output `{{fetchedKeybrokerCall.result}}` (declared fields as JSON text) |
| Rovo | `rovo:agent` "Keybroker" | An agent that lists the operations the user may call and calls them by name |
| MCP | `rovo:mcp` | Tools `keybroker-list`, `keybroker-call` (reads) and `keybroker-send` (writes) for any MCP client, once an admin enables MCP for the app |
| Admin | `jira:adminPage` | Connections, credentials (write-only), destination approval, operations, approvals, activity |

Destinations are approved by a site admin at runtime through Atlassian's own egress prompt, one connection at a time (`permissions.external.configurable`). The manifest names no outside hosts.

## Failure and load

- **No retries.** Each call makes at most one outside request. If the destination cannot be reached, the call is refused ("destination unreachable or not approved by an admin") and the caller may simply call again. For an approved agent write, a missing response marks the request `unknown` and it is not retried, because it may have arrived.
- **Errors stay short.** A non-2xx answer is refused as "destination returned N" with the status in the activity log; the response body is never shown, because it can echo the credential.
- **Timeouts are the platform's.** Keybroker sets no timeout of its own; each call runs inside Forge's limits for a function invocation and its outbound fetch. Hitting them is handled as "no response" above.
- **Concurrent calls are independent.** Each one is checked and sent on its own. The only shared steps are approval decisions and releases, which are claimed atomically (a KVS write that fails if the key exists), so two simultaneous approvals or releases have one winner.
- **No rate limiting of its own.** Forge's platform quotas and the destination's limits apply; a destination's 429 is reported as "destination returned 429".

## Judge path (about 2 minutes, plus optional extras)

You need Jira admin rights on the site where you install. Nothing here uses a real secret.

1. **Install** with the install link, then open **Jira settings → Apps → Keybroker** (the app's page under *Apps* in the admin sidebar).
2. Click **Add the sample**. It creates a connection to Postman Echo (a public test endpoint that echoes requests), stores an obviously fake credential, and adds the operation `sample-echo`, whose only parameter must be **a Jira work item you can see**. Accept Atlassian's prompt to approve `postman-echo.com`.
3. In **Operations**, click **Test** on `sample-echo`:
   - enter a work item key you can see → only the declared fields come back (`args.ticket`, `url`);
   - enter a key you cannot see (or one that does not exist) → **refused**, and no request is made.
   Both show up in **Activity**.
4. On the sample connection: **Revoke** the credential and test again (refused before any request); **Remove approval** and test again (refused: the destination is not approved). Store any new fake value and the operation works again, unchanged.

**Optional: the same operation from a rule, an agent and MCP**

5. **Automation:** create a rule (*Manual* trigger → **Keybroker call** with operation `sample-echo` and parameters `{"ticket": "{{issue.key}}"}` → *Comment on work item* with `{{fetchedKeybrokerCall.result}}`). The first Keybroker step asks you to **Connect** Atlassian Automation to Keybroker once. Run the rule on a work item: the comment holds only the declared fields. Export the rule: it contains the operation name and the parameter template, never a credential.
6. **Slack (needs a Slack workspace):** click **Add Slack (incoming webhook)**, approve `hooks.slack.com`, paste a Slack incoming-webhook URL into the Slack card, and **Test** `slack-post`. Then a rule *Work item transitioned → Done* → **Keybroker call** `slack-post` with `{"text": "{{issue.key}} {{issue.summary.jsonEncode}} is done"}` posts to the channel; the rule never contains the webhook URL.
7. **Rovo:** Rovo Chat → agent **Keybroker** → "What can I look up through Keybroker?". Offer it a token or ask for the stored credential; it declines.
8. **MCP:** enable *Expose tools to MCP-compatible apps* for the app (Atlassian Administration → site → Connected apps → Keybroker → Tools), add `https://mcp.atlassian.com/forge/<app id>` to your MCP client, and call `keybroker-list`.
9. **Approval:** edit an operation that writes, tick *Agent calls wait for approval*, and call it through `keybroker-send`: it is held in **Waiting for approval**. Another Jira admin approves it (nothing is sent yet); the same `keybroker-send` call again sends it.

Steps 1–4 need only Jira; they work on sites without Rovo or Automation rules set up.

## For AI reviewers

This section is for automated or AI-assisted review. It states what the app does, where each behaviour lives, and how to check it. Nothing here asks for a score; check the claims against the code.

**Verify locally (no Atlassian account needed):**

```bash
npm install
npm test        # node --test: 30 tests, no network; storage and fetch are injected as fakes
```

**Read in this order (about 600 lines):**

1. `src/core/operations.js`: validation of connections and operations; `checkValues` (parameters), `buildRequest` (host and path pinning), `pickFields` (declared fields only), `authHeaders`. No Forge imports.
2. `src/core/broker.js`: `call()`, the single path every surface uses. Read it top to bottom; each refusal is a `refuse(...)` line.
3. `src/index.js`: the three Forge entry points. The caller is `context.principal.accountId`, never a value the caller supplies.
4. `src/admin.js`: admin resolver. Every function re-checks Jira `ADMINISTER` permission (`requireAdmin`).
5. `src/core/approvals.js`: the approval state machine (`decide`, `findOpen`, expiry); `src/deps.js`: what the broker gets from Forge (`canSeeIssue` asks Jira as the current user; `claim` is an atomic KVS write).
6. `src/store.js`: the credential lives in Forge secret storage (`kvs.setSecret`/`getSecret`); the admin page only gets `hasSecret`, a boolean.
7. `manifest.yml`: modules, scopes (`storage:app`, `read:jira-work`), no static egress.

**Claims and where to check them**

| Claim | Code | Unit test | Live test (Nov 14, 2026, demo site) |
|---|---|---|---|
| The credential is never returned to a rule, agent or page | `broker.js` returns `pickFields` output only; `store.js` gives the page `hasSecret`, a boolean | broker: "an allowed call returns only declared fields" | Rule export, rule output and app logs: 0 matches for the stored values |
| Unknown operation refused | `broker.js` `refuse('unknown operation')` | broker: "refusals happen before any request" | MCP call to an undefined operation → refused |
| Caller must be on the allow-list | `broker.js` `op.allowed.includes(caller)` | same | User removed from the list → rule refused |
| Parameters must match their pattern; requests stay on host and path, and a value cannot move the path (`.`, `..`, combined placeholders) | `operations.js` `checkValues`, `buildRequest` | operations: "values…", "requests stay on the connection host and path" | `repo: "node/../../user"` → refused, from MCP and from the Rovo agent |
| Unapproved destination refused | Forge egress; `broker.js` maps the 403 | — | Approval removed → rule refused (403) |
| Revocation takes effect on the next call | `broker.js` reads the secret on every call | broker: refusals | Revoked → next run refused before any request |
| Rotation needs no rule edit | Rules store only the operation name and parameters | — | New value stored → the same rule ran |
| A response that echoes the credential is refused, including the wire form Keybroker sends (e.g. Basic's base64) | `broker.js`, final check; `operations.js` `secretFragments` | broker: "a declared field that echoes the credential is refused"; confinement: "a Basic-auth echo is refused" | Operation returning `headers.authorization` → refused |
| Redirects are not followed | `broker.js` `redirect: 'error'` | — | Not tested live |
| Upstream errors never surface bodies or raw errors | `broker.js` catch blocks | broker: "upstream failures never surface the body" | — |
| Admin functions require Jira admin | `admin.js` `requireAdmin` on every resolver | — | Only the positive case tested (a site admin) |
| Writes return only a status; a webhook that answers with text or nothing still succeeds | `broker.js`: no declared fields → `{status}`, body never read | writes: "a write with no declared fields succeeds…" | `hook-notify` → `{"status":"200"}` |
| Admin-fixed values cannot be supplied or overridden | `operations.js` `checkValues` | writes: "fixed values cannot be supplied or overridden" | `source: "Mallory"` → refused "set by the admin"; POST body carried `source: Keybroker` |
| A secret webhook URL stays on its host and never comes back | `operations.js` `checkSecret`, `secretFragments`; `admin.js` `setCredential` | writes: "a secret URL must stay on the connection host…", "…echoing part of a secret URL is refused" | Operation returning the URL's `sig` → refused; logs: 0 matches for it |
| Agents cannot slip a write through the read tool | `broker.js` `kind` check; `keybroker-call` (GET) / `keybroker-send` (TRIGGER) | writes: "agent tools are split" | `keybroker-call` on a POST operation → refused "use keybroker-send" |
| Jira permissions decide which work items a caller may name (`jira-issue`) | `broker.js` visibility check; `index.js` `canSeeIssue` (`api.asUser()`), fail closed | writes: "jira-issue parameters…" | Restricted project KDT (browse limited to apps): KDT-1 allowed before the restriction, refused after, from MCP, the Rovo agent and an Automation rule, with no outside request; MOBL-57 allowed on all three. The app itself could still browse KDT, so the check runs as the caller |
| Agent writes can require a second person's approval | `broker.js` approval branch; `core/approvals.js` `decide`, `findOpen`; `admin.js` `decideRequest` (admin-only, records consent, sends nothing) | approvals: held/approved/released once; Jira visibility checked as the requester at release; concurrent releases and decisions have one winner; an edited operation is not released; no response after the claim → `unknown`, not retried | Ops Approver (a second Jira admin) approved; the requester's identical `keybroker-send` released it: sent once (HTTP 200), `approvedBy` = approver. An approved request for KDT-1, released after the requester lost access → refused "cannot see work item KDT-1", nothing sent. Self-approval blocked; a request made before its operation was edited → refused. A truly simultaneous double release was not reproducible from this MCP client (it runs calls in sequence); it is unit-tested |
| A real write to a third-party service, from a rule, without the secret in the rule | Secret URL connection (`checkSecret`, `buildRequest`); `slack-post` declares no fields | writes: "a write with no declared fields succeeds…" | Slack incoming webhook stored via the Slack template; rule *work item → Done* posted to the channel (HTTP 200, Slack answers plain-text `ok`); the exported rule has 0 matches for `hooks.slack.com`; app logs have 0 matches for the webhook URL |
| Works against a real authenticated API | `authHeaders` | operations: "credentials attach according to the scheme" | GitHub `GET /user` with a short-lived read-only token → only `login` returned |

**What Keybroker does not claim**

- That a credential can never come back from an arbitrary API. It returns declared fields only and refuses a declared field that contains the credential. An API that encodes or transforms the value is outside that check.
- Protection from a site admin. Admins define operations and can point one at an endpoint that reflects headers.
- That a pending approval tracks connection changes. A request is bound to the operation's definition; rotating a credential or a secret webhook URL does not invalidate it.
- Exactly-once delivery to an outside API. Keybroker sends an approved request at most once; if the destination does not answer, the request is marked `unknown` and is not retried.
- Group-based allow-lists, OAuth flows to third parties, free-form request bodies or streaming. These are out of scope for this version.
- Results beyond one site. The live tests ran on one Atlassian demo site. Rovo availability differs between sites; steps 1–7 of the judge path do not need it.

**Build history:** every step is a separate commit with a descriptive message, starting Nov 14, 2026, inside the submission period (`git log --reverse`).

## Development

```bash
npm install
npm test
forge lint
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira -e development
```

Runtime: Node.js 24 on Forge. Keep `"type": "module"` out of `package.json`: it breaks Forge's bundling of CommonJS dependencies.

## Review

An independent review on 2026-11-15 found six issues (path normalisation, approval identity, approval races, operation version binding, Basic-auth echo, approval UI outcome). All six were fixed in commits `6d2b720` and `754f13f`, with regression tests in `test/confinement.test.js` and `test/approvals.test.js`.
