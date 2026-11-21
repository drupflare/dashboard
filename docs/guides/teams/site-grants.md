---
title: Site grants
description: Give one person access to one site without a wider role.
audience: [department-owner, agency]
type: written
draft: true
---

This page shows you how to give one person access to one site. It is for owners and site admins.

A site grant gives one person one site role on one site. It does not change their organization role.

Use a grant when someone needs one site and nothing else, such as a developer who maintains a single client site.

## Add a grant

Open the site's Collaborators page at `/sites/<id>/collaborators`. The page lists everyone with a grant on the site.

1. Enter the email address of a person who already has a Drupflare account. An address with no account is refused. Invite the person to the organization first.
2. Pick a site role: Site Admin, Maintainer or Viewer. See [Roles and permissions](/docs/guides/teams/roles-and-permissions).
3. Pick an expiry: Never, 30 days, 90 days, 180 days or 1 year.

## Change or remove a grant

- To change the role, pick the new role. The expiry stays as it was.
- To remove a grant, remove it from the list. The person can no longer act on that site once you save the change.
- A grant with an expiry stops working after that date. The server ignores expired grants.

The controls show only when your organization role allows site grant changes. A site admin who holds only a grant sees the list without controls, and the server still checks each request.

## Limits

- A grant covers one site. Add a grant on each site that needs one.
