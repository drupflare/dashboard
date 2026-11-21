---
title: The repair ladder explained
description: The steps the platform takes when a problem keeps coming back, in order, and which of them run on their own.
audience: [developer, agency, central-it]
type: written
draft: true
---

This page explains the steps the platform climbs when a problem keeps coming back. It is for owners reading a repair history.

When a problem keeps coming back, the platform climbs a ladder of steps. Each step is tried only if the step before it did not clear the problem.

## The steps in order

1. **Observe.** The platform watches the site and records each failure.
2. **Repair.** A named repair for the problem runs. A repair runs only when its conditions hold. For example, it runs only when no database transaction is open.
3. **Quarantine.** After three failures in a row on the same problem, the site is quarantined. See [quarantine](/docs/troubleshooting/quarantine).
4. **Rollback.** The site goes back to its last restore point. Rollback waits for repeated failures, a waiting period in quarantine, and a restore point that holds data.

## Which steps run on their own

The platform starts a named repair on its own when the repair is set to automatic and its conditions hold. A repair that needs approval or a person waits for one.

Quarantine and rollback are decided on the site itself. Check the **Automatic Repairs** page to see which step ran and when.

## What you see

The site's **Automatic Repairs** page lists each repair with its time and result. The health view shows the step the site is on. A site on a higher step needs a person to look at it.

See [health and repairs](/docs/concepts/health-and-repairs) for the repair classes.
