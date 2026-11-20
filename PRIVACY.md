# Keybroker privacy policy

Last updated: 20 November 2026

Keybroker is a Forge app for Jira. It runs on Atlassian's Forge platform, in the Atlassian site where it is installed. The developer runs no servers of their own and receives none of the data below.

## What Keybroker stores

All of this is kept in Forge storage for the site where the app is installed:

- **Credentials** that an admin stores for a connection (an API token or a secret webhook URL). They are kept in Forge's encrypted secret storage, are never shown again after they are saved, and are never returned to Automation rules, Rovo agents or MCP clients.
- **Connections and operations** that an admin defines: destination hosts, paths, parameter rules, returned fields and who may call each operation.
- **An activity log** of calls: time, operation name, the caller's Atlassian account ID, where the call came from (Automation, Rovo, MCP or an admin test), the outcome, the HTTP status and, for an approved request, the approver's Atlassian account ID.
- **Approval requests** for operations that need a second person: the operation, the parameter values the caller supplied (for example the text of a Slack message), the caller's and the approver's Atlassian account IDs, and times.

Atlassian account IDs are kept until the records are deleted. Credentials, connections and operations can be deleted from the admin page at any time.

## What Keybroker sends

Keybroker sends a request only to a destination that a site admin has approved in Atlassian's own prompt, only for an operation an admin defined, and only with the parameter values the caller supplied plus the stored credential. It returns to the caller only the fields the operation declares.

## Logs

The app writes operational logs to Forge's logging service (for example "call allowed" or "credential rotated"). These logs never contain credentials. A site admin decides whether the developer can see them.

## Contact

Questions or requests: <https://github.com/fexx301/keybroker/issues>
