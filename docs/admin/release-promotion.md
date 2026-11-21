---
title: Release promotion
description: Admin runbook for promoting a release from one ring to the next, and for the switch that stops promotion.
audience: [developer]
type: written
draft: true
---

A release is registered from its manifest (the file that describes the release) on the Releases page at `/admin/releases`. Starting a rollout moves it through the rings in order. A ring is one of six groups of sites, R0 to R5.

Before you start a rollout:

1. Check the Flags page at `/admin/flags`. If Stop Release Promotion is on, starting a rollout is refused.
2. Check the operations for any rollout already running. Only one rollout can run at a time.

The Stop Release Promotion switch works in two places. It refuses a new rollout straight away. The engine also reads it before each ring starts, so a rollout that is already running halts before its next ring. The halt is recorded on the rollout. For the full steps when a release is failing, see [Ring halt](/docs/admin/ring-halt).

Owners and admins of an organization approve operations on their own sites. See [Rollout governance](/docs/institutions/rollout-governance).
