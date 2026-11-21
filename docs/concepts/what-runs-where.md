---
title: What runs where
description: Where a site's code, data and records live on each plane, and what the dashboard keeps.
audience: [security-reviewer, central-it, developer]
type: written
draft: true
---

The dashboard keeps records about your organization, its sites and its operations. It keeps them whichever plane a site uses. Records include site names, operation history, readiness and the audit log.

The site itself runs on the plane you chose:

- **Managed.** The site runs in Drupflare's Cloudflare account.
- **Self-managed.** The site runs in your Cloudflare account, and Drupflare works in that account with the token you gave it.
- **Self-hosted.** The site runs on your node. The node reports status and some findings to the dashboard. It does not send site content, databases, secrets, environment values or log bodies.

The node contract lists exactly what leaves the box. See [what leaves your box](/docs/guides/self-hosted/what-leaves-your-box) and the [fleet link reference](/docs/reference/fleet-link).

For what the platform stores and for how long, read [what we store](/docs/security/what-we-store) and [data retention](/docs/security/data-retention).
