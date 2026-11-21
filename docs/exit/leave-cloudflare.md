---
title: Leave Cloudflare
description: Move a site off Cloudflare and what changes for its DNS, email and cache.
audience: [developer, self-hosting-operator]
type: written
draft: true
---

A guide for moving a site off Cloudflare is not written yet. Not available yet.

Drupflare runs sites on Cloudflare, so a move off Cloudflare means a move off Drupflare too. Before you start, check these:

- **DNS** (the records that point your domain names at servers). Your hostnames point to Cloudflare while the site runs there. Plan the new records and their time to live (how long other servers keep an old answer).
- **Email.** Check every service that sends mail for the site's domain before you change its DNS.

Export the site first. See [Export everything](/docs/exit/export-everything). To run it on a server you own, see [Restore onto a bastion](/docs/exit/restore-onto-bastion) (a bastion is the software a node runs).
