---
title: What Drupflare is
description: What Drupflare runs, where a site can live, and what you do in the dashboard.
audience: [solo-beginner, agency, nonprofit, department-owner, central-it]
type: written
draft: true
---

Drupflare runs Drupal sites on Cloudflare. You create a site in the dashboard. Drupflare builds it, serves it, and records each change as an operation (one change to a site, with steps you can follow) in the site's activity.

You can start a site in three ways:

- **Create a Drupal site.** Pick a template and Drupflare builds the site.
- **Upload your own Worker.** Use this when your code is already built for Cloudflare Workers.
- **Import a site from a server.** Drupflare checks the server first. The check changes nothing on your server.

Every site runs on one of three planes. [Choose a plane](/docs/start/choose-a-plane) explains the difference.

Before people rely on a site, check its readiness. The [first-day checklist](/docs/start/first-day-checklist) lists the steps.

## What is not ready yet

Some parts of the platform are still being built. In this release:

- Custom domains may be off for your account. When they are off, attaching a domain waits, and nothing is attached. See [domains and names](/docs/concepts/domains-and-names).
- There is no command-line tool. Use the dashboard or the [API](/docs/reference/api/index).
- Outbound webhook events (automatic messages sent to another system's web address) are defined but not yet delivered. See [webhooks](/docs/reference/api/webhooks).
