---
title: Connect an AI client
description: Let an AI client such as Claude Code call the Drupflare API with a key you control.
audience: [developer, agency]
type: written
draft: true
---

Drupflare publishes its API as an OpenAPI description. A gateway called MyMCP reads that description and turns each operation into a tool, so an AI client can list your sites or read an entitlement without custom code. The client connects with an API key, and the key limits what it can do.

## Get a key

Go to `/org/api-keys` and select Create a Key. Name it, pick an expiry and tick only the permissions the client needs. The dashboard asks you to confirm it's you, then shows the key once. Copy it then. Drupflare stores only a hash, so a lost key means a new one.

A key can never hold a permission you don't hold yourself. If your role changes, the key follows your new standing the next time it's used.

## Add it to Claude Code

The key page builds this command for you with your filters applied. The placeholder stands in for the key.

```sh
claude mcp add --transport http drupflare 'https://mymcp.gmitch215.xyz/drupflare/mcp' --header "X-Mcp-Upstream-Authorization: Bearer <paste the key>"
```

To keep the key out of shell history and out of a file you commit, put it in an environment variable and reference it from `.mcp.json`.

```json
{
  "mcpServers": {
    "drupflare": {
      "type": "http",
      "url": "https://mymcp.gmitch215.xyz/drupflare/mcp",
      "headers": {
        "X-Mcp-Upstream-Authorization": "Bearer ${DRUPFLARE_API_KEY}"
      }
    }
  }
}
```

## Filter what the client sees

Add query parameters to the URL.

- `tags=sites,domains` offers only operations under those API tags.
- `methods=get` offers read operations only.
- `confirm=write` makes the client ask you before any call that changes something.

Combine them with `&`, and keep the URL in single quotes so the shell doesn't read `?` as a wildcard. For a first connection, `methods=get` with `confirm=write` is a sensible start.

## What a key can never do

A key can't perform anything that needs you at the keyboard. That covers session-only actions, such as managing your account and security settings, connecting a repository, pairing a node, opening the billing portal and creating or revoking keys. It also covers actions that ask for a fresh confirmation, such as deleting an organization, adopting or importing a site, running a cutover and managing a custom domain. Admin actions count as session-only. The client sees these tools, and the dashboard refuses them. The permissions reference lists every action.

## Keep the key safe

Send a key only to the dashboard host through the gateway header shown above. Never paste a key into a chat, a ticket or a prompt, and never put it in a URL, because clients log URLs. Give each client its own key so you can revoke one without touching the rest.

## Revoke a key

Open API keys, find the key and select Revoke. A key used in the last 24 hours asks you to type its name first, because something is probably still running on it. Revoking takes effect on the next request. The key stays in the list as revoked, and the audit log records who issued it and who revoked it.
