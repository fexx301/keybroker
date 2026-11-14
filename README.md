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

An admin adds a **connection** (a destination and how the credential is attached) and stores the credential once. The admin then defines **operations**: a method, a path, the parameters a caller may supply (each with where it goes and a pattern its value must match), the fields that may come back, and who may call it.

A rule, an agent or an MCP client calls an operation **by name**. Keybroker then:

1. checks that the caller, taken from Forge's invocation context, is on that operation's allow-list;
2. checks every parameter against its pattern and builds the request; the final URL must stay on the connection's host and path;
3. attaches the credential, makes the request, and refuses redirects;
4. returns **only the declared fields**, and refuses if one of them contains the credential;
5. records the call or refusal, with its reason, in an activity log.

Rotating or revoking happens in one place. No rule changes.

The caller proposes; Keybroker's code decides.

## Surfaces

| Surface | Module | What the caller gets |
|---|---|---|
| Jira Automation | `action` + `automation:actionProvider` | A "Keybroker call" step; output `{{fetchedKeybrokerCall.result}}` (declared fields as JSON text) |
| Rovo | `rovo:agent` "Keybroker" | An agent that lists the operations the user may call and calls them by name |
| MCP | `rovo:mcp` | Tools `keybroker-list` and `keybroker-call` for any MCP client, once an admin enables MCP for the app |
| Admin | `jira:adminPage` | Connections, credentials (write-only), destination approval, operations, activity |

Destinations are approved by a site admin at runtime through Atlassian's own egress prompt, one connection at a time (`permissions.external.configurable`). The manifest names no outside hosts.

## Judge path (about 10 minutes)

You need Jira admin rights on the site where you install. Use a **made-up credential** such as `synthetic-test-1`; the test endpoint below accepts any value.

1. **Install** with the install link, then open **Jira settings → Apps → Keybroker**.
2. **Add a connection.** Name `Postman Echo`, ID `echo`, base URL `https://postman-echo.com`, sent as a Bearer token.
3. On its card, click **Approve postman-echo.com** and accept Atlassian's prompt. Type `synthetic-test-1` in **Credential** and click **Store credential**.
4. **Add an operation.**
   - Name `echo-ticket`, connection Postman Echo, method GET, path `/get`
   - Parameters: `ticket query [A-Z][A-Z0-9]+-[0-9]+`
   - Returned fields: `args.ticket, url`
   - Who may call it: yourself
5. **Automation.** Create a rule: trigger *Manual*, then the action **Keybroker call** with operation `echo-ticket` and parameters `{"ticket": "{{issue.key}}"}`, then *Comment on work item* with `{{fetchedKeybrokerCall.result}}`. Run it on any work item: the comment holds only the declared fields.
6. **See it refuse.** Each of these leaves the rule untouched and shows up in Keybroker's **Activity**:
   - **Remove approval** → the next run is refused (the destination is not approved).
   - **Revoke** → refused before any request is made.
   - Remove yourself from **Who may call it** → "caller is not allowed to use this operation".
   - Store `synthetic-test-2` → the unchanged rule works again (rotation).
7. **Export the rule** (rule menu → Export) and search the file for `synthetic`: it holds only the operation name and the parameter template.
8. **Optional: an agent.**
   - **Rovo Chat** → agent **Keybroker** → "What can I look up through Keybroker?".
   - **MCP:** enable *Expose tools to MCP-compatible apps* for the app in Atlassian Administration (site → Connected apps → Keybroker → Tools). Add `https://mcp.atlassian.com/forge/<app id>` to your MCP client, then call `keybroker-list`.
   - Ask an agent to show you the credential, or offer it one; it declines.

The core path (steps 1–7) needs only Jira and Automation, so it works on sites without Rovo.

## For AI reviewers

This section is for automated or AI-assisted review. It states what the app does, where each behaviour lives, and how to check it. Nothing here asks for a score; check the claims against the code.

**Verify locally (no Atlassian account needed):**

```bash
npm install
npm test        # node --test: 12 tests, no network; storage and fetch are injected as fakes
```

**Read in this order (about 420 lines):**

1. `src/core/operations.js`: validation of connections and operations; `checkValues` (parameters), `buildRequest` (host and path pinning), `pickFields` (declared fields only), `authHeaders`. No Forge imports.
2. `src/core/broker.js`: `call()`, the single path every surface uses. Read it top to bottom; each refusal is a `refuse(...)` line.
3. `src/index.js`: the three Forge entry points. The caller is `context.principal.accountId`, never a value the caller supplies.
4. `src/admin.js`: admin resolver. Every function re-checks Jira `ADMINISTER` permission (`requireAdmin`).
5. `src/store.js`: the credential lives in Forge secret storage (`kvs.setSecret`/`getSecret`); the admin page only gets `hasSecret`, a boolean.
6. `manifest.yml`: modules, scopes (`storage:app`, `read:jira-work`), no static egress.

**Claims and where to check them**

| Claim | Code | Unit test | Live test (Nov 14, 2026, demo site) |
|---|---|---|---|
| The credential is never returned to a rule, agent or page | `broker.js` returns `pickFields` output only; `store.js` gives the page `hasSecret`, a boolean | broker: "an allowed call returns only declared fields" | Rule export, rule output and app logs: 0 matches for the stored values |
| Unknown operation refused | `broker.js` `refuse('unknown operation')` | broker: "refusals happen before any request" | MCP call to an undefined operation → refused |
| Caller must be on the allow-list | `broker.js` `op.allowed.includes(caller)` | same | User removed from the list → rule refused |
| Parameters must match their pattern; requests stay on host and path | `operations.js` `checkValues`, `buildRequest` | operations: "values…", "requests stay on the connection host and path" | `repo: "node/../../user"` → refused, from MCP and from the Rovo agent |
| Unapproved destination refused | Forge egress; `broker.js` maps the 403 | — | Approval removed → rule refused (403) |
| Revocation takes effect on the next call | `broker.js` reads the secret on every call | broker: refusals | Revoked → next run refused before any request |
| Rotation needs no rule edit | Rules store only the operation name and parameters | — | New value stored → the same rule ran |
| A response that echoes the credential is refused | `broker.js`, final check | broker: "a declared field that echoes the credential is refused" | Operation returning `headers.authorization` → refused |
| Redirects are not followed | `broker.js` `redirect: 'error'` | — | Not tested live |
| Upstream errors never surface bodies or raw errors | `broker.js` catch blocks | broker: "upstream failures never surface the body" | — |
| Admin functions require Jira admin | `admin.js` `requireAdmin` on every resolver | — | Only the positive case tested (a site admin) |
| Works against a real authenticated API | `authHeaders` | operations: "credentials attach according to the scheme" | GitHub `GET /user` with a short-lived read-only token → only `login` returned |

**What Keybroker does not claim**

- That a credential can never come back from an arbitrary API. It returns declared fields only and refuses a declared field that contains the credential. An API that encodes or transforms the value is outside that check.
- Protection from a site admin. Admins define operations and can point one at an endpoint that reflects headers.
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
