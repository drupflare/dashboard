---
title: Command-line tool
description: Whether Drupflare has a command-line tool in this release, and what to use instead.
audience: [developer, self-hosting-operator]
type: written
draft: true
---

Drupflare does not ship a command-line tool (a program you run in a terminal) in this release. Do these tasks in the dashboard or through the HTTP API (the web address that scripts call).

- To manage sites, organizations and keys from a script, call the [API](/docs/reference/api/index). Create an API key on the organization's API keys page, and send it as a bearer token (a key sent in the `Authorization` header). See [authentication](/docs/reference/api/authentication).
- To run a node without the dashboard, see [run without the dashboard](/docs/guides/self-hosted/run-without-the-dashboard).

Commands that appear in older notes or in other tools' documentation do not apply to this release.
