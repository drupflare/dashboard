---
title: Releases and rings
description: How a release reaches sites in rings, what the rollout watches, and when it stops or goes back.
audience: [developer, central-it, agency]
type: written
draft: true
---

A release is one version of the code a site runs. Releases do not reach every site at once. They roll out through six rings, R0 to R5, in order. A ring holds a group of sites, and the rollout moves to the next ring only when the one before it looks healthy.

## Which ring a site is in

The dashboard sorts sites by traffic, workload class (static, content, application or commerce) and criticality.

- A site with low criticality, low traffic and a static or content workload lands in R3.
- A site with high criticality, heavy traffic or a commerce workload lands in R5.
- Every other site lands in R4.

An owner can only move a site later in the order. A platform admin can place a site in any ring.

## What the rollout watches

At each ring the dashboard reads six measures:

- the share of requests that failed
- site resets
- memory growth over the window
- cold starts
- repair findings
- failed writes

If a measure passes the halt limit, the rollout stops where it is. If a measure passes the severe limit, the ring goes back to the previous release.

The limits are placeholders. They are not final until a real rollout has been measured. A rollout is a safety check. It makes no promise about any one release.

See [health and repairs](/docs/concepts/health-and-repairs) for where the findings come from.
