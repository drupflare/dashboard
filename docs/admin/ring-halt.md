---
title: Ring halt
description: Admin runbook for stopping a release rollout that is failing in a ring.
audience: [developer]
type: written
draft: true
---

Use this runbook when a release is failing in a ring (one of six groups of sites) and more promotions would make it worse.

1. Turn on Stop Release Promotion on the Flags page at `/admin/flags`. From then on, new rollouts are refused.
2. A rollout that is already running halts before its next ring starts. Check the Releases page at `/admin/releases` to confirm it has stopped. The halt is recorded as "an admin stopped the rollout."
3. If a site in the failing ring needs more than the halt, a developer in the organization can cancel that site's operation. See [Rollout governance](/docs/institutions/rollout-governance).
4. Tell the affected organizations which sites are paused, and why.

The halt stops the whole rollout. Stopping one ring while the others continue is not built.

When the failure is fixed, turn the switch off. Record the time and the sites affected. A switch that stays on refuses every new rollout, so check the switch before you start the next one.
