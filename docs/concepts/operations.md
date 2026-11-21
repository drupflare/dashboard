---
title: Operations
description: How a change to a site runs as an operation, what its statuses mean, and what happens when you leave the page.
audience: [developer, agency, central-it]
type: written
draft: true
---

Every change to a site runs as an operation. Creating a site, updating its code, restoring a backup, attaching a domain and installing a module are all operations. The operation keeps a record of what it did. The [operations reference](/docs/reference/operations) lists the types.

## Statuses

An operation moves through these statuses:

- **Planned.** The change is set out and waiting to start.
- **Awaiting approval.** The change needs a person to approve it before it runs.
- **Running.** Steps are executing.
- **Verifying.** The steps finished, and the result is being checked.
- **Succeeded.** The change is in place.
- **Failed.** A step failed. The progress screen names the failure.
- **Cancelled.** Someone stopped it before it finished.
- **Rolled back.** The change was undone after it started.

Each step has its own state: pending, running, succeeded, failed or skipped. A verification check can be pending, passed, failed or not required.

## Leaving the page

Most operations keep running when you leave the progress screen. The screen says so for each type. Open the site's activity to see an operation again.

## When one fails

The progress screen shows the failure and, for most types, a button to go back to the page you came from. Some failed operations can be retried. A retry starts a new operation that points back at the failed one, and it asks for the same permission the first start needed. Where a type cannot be retried, the screen says so.
