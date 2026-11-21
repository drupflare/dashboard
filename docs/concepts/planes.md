---
title: Planes
description: How each plane divides the work between Drupflare, your Cloudflare account and your own server.
audience: [central-it, security-reviewer, developer, self-hosting-operator]
type: written
draft: true
---

A plane is the place a site runs. It also sets who operates the infrastructure and who holds its credentials. [Choose a plane](/docs/start/choose-a-plane) compares the three for a first decision. This page covers what changes between them.

| Plane        | Runs in                        | Credentials held by                 | Changes made by                 |
| ------------ | ------------------------------ | ----------------------------------- | ------------------------------- |
| Managed      | Drupflare's Cloudflare account | Drupflare                           | The dashboard                   |
| Self-managed | Your Cloudflare account        | Drupflare, through a token you give | The dashboard, in your account  |
| Self-hosted  | A node you run, with Bastion   | You, on the node                    | The dashboard, through the node |

When you revoke a self-hosted node, it keeps running on its own. The dashboard cannot send it commands until you pair it again. See [unpair](/docs/guides/self-hosted/unpair).

For what the dashboard stores about each plane, see [what runs where](/docs/concepts/what-runs-where).
