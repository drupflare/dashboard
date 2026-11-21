---
title: Rollout governance
description: Who approves a rollout, what they review, and when a rollout must stop.
audience: [central-it]
type: written
draft: true
---

A rollout moves a new release to the sites in your organization. Decide who approves it before the first rollout.

## Who approves

- Owners and admins can approve an operation (a change to a site) and manage releases.
- Developers can cancel and retry operations.

Name the approver for each wave in your plan.

## What to review

Check the release notes and the sites in the wave. Confirm that each site has a restore point before its update. See [Restore points](/docs/guides/data/backups).

## When a rollout must stop

A platform switch can stop new rollouts from starting. A rollout that is already running halts before it starts its next ring. A ring is one of six groups of sites, R0 to R5, that a release rolls out through in order. A developer can cancel a running operation on one site.

Write your stop rule in advance. Examples: a fixed number of failed sites, or any site that goes down.

Related: [Automatic repairs](/docs/guides/monitoring/automatic-repairs) and [Releases and rings](/docs/concepts/releases-and-rings).
