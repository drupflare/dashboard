---
title: Rollback refused
description: Why the dashboard refuses a code rollback, and what to do when the earlier code cannot run on the current data.
audience: [developer, agency]
type: written
draft: true
---

This page helps you understand why a rollback is refused. It is for site owners.

The dashboard checks a rollback before it runs. It refuses the rollback when it cannot be done safely.

## Common reasons

- **The earlier code cannot read the current data.** A later release changed the layout of the data, and the earlier code cannot read it.
- **The target is a different kind of release.** A site runs one kind of release. The dashboard refuses a target of another kind, unless the site's own release is registered as that kind.

The refusal says which reason applies.

## What to do

For the first reason, you have two choices:

1. Restore the data along with the code. Pick a restore point from before the change, and roll back both.
2. Fix the problem in a new release, and roll forward (deploy a newer release that fixes it).

For the second reason, choose a release of the same kind as the site's current one.

See [roll back code](/docs/guides/code/roll-back-code) and [restore a backup](/docs/guides/data/restore-a-backup).
