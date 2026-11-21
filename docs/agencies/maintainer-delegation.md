---
title: Maintainer delegation
description: Give a maintainer access to a client's site without giving them the client account.
audience: [agency, developer]
type: written
draft: true
---

A maintainer can deploy and maintain one client site without access to the client's organization. Use a site grant with the Maintainer role.

## Steps

1. The maintainer creates a Drupflare account. A grant needs an existing account.
2. An admin on the site opens its Collaborators page and adds the maintainer's email.
3. Pick the Maintainer role and an expiry. Expiries are 30 days, 90 days, 180 days, 1 year, or never.

The maintainer can deploy, roll back, install and remove modules, run backups and read logs. They cannot change site settings, domains or grants, and they cannot restore backups. Those need the site admin role. See [Roles and permissions](/docs/guides/teams/roles-and-permissions).

## Ending the access

Remove the grant when the work is done. Set a short expiry for contractors so access ends on its own.

Automation should use an API key (a secret string that scripts send to the API) with only the actions it needs. See [API keys](/docs/guides/teams/api-keys).
