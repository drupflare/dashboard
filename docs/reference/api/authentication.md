---
title: Authentication
description: How to authenticate to the API with an API key or a browser session, and what a key can and cannot do.
audience: [developer]
type: written
draft: true
---

The API accepts two kinds of credential (a key or session that proves who you are).

- **An API key** sent as a bearer token. Use this in scripts and integrations (connections to other software).
- **A browser session.** The dashboard uses this when you are signed in. A script does not need one.

## API keys

A key starts with `dfk_`. Send it in the `Authorization` header:

```http
Authorization: Bearer dfk_...
```

Create keys on the organization's **API Keys** page. When you create one, choose:

- **Scopes** (permissions). Each scope allows one kind of action, such as reading an organization. Give a key only the scopes its job needs.
- **Expiry** (how long the key works). 30, 90, 180 or 365 days.
- **Organizations and sites.** Optionally, limit the key to some organizations or sites.

Revoke a key on the same page when you no longer need it.

Some actions need a browser session and cannot be done with a key. Changing account security settings is one example. The API refuses a key for those actions.

See [API keys](/docs/guides/teams/api-keys) for the steps.
