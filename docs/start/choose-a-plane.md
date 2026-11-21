---
title: Choose a plane
description: Compare the managed, self-managed and self-hosted planes, and pick the one that fits where your site must run.
audience: [solo-beginner, developer, agency, central-it, self-hosting-operator]
type: written
draft: true
---

A plane sets where a site runs and who holds its infrastructure. You pick the plane when you create the site.

## Managed

Drupflare runs the site in its own Cloudflare account. You do not connect a Cloudflare account. This is the simplest choice for a new site.

## Self-managed

The site is created in your Cloudflare account. You give the dashboard an API token for that account, and Drupflare uses it to create and check the site. Limit the token to the permissions in [token permissions](/docs/guides/self-managed/token-permissions). [Connect Cloudflare](/docs/guides/self-managed/connect-cloudflare) walks through the setup.

## Self-hosted

The site runs on a server you operate, called a node. The node runs Bastion (the software that links it to the dashboard), and you pair it with the dashboard. A paired node reports its status and takes commands. If you revoke the node, it keeps running on its own. [Install Bastion](/docs/guides/self-hosted/install-bastion) covers the setup.

## Moving between planes

A self-managed site can also run as a managed site. The original stays as it was. See [adopt to managed](/docs/guides/self-managed/adopt-to-managed).

For what each plane holds and who operates it, read [what runs where](/docs/concepts/what-runs-where).
