---
title: Operations reference
description: The operation types the platform records, the title each one shows on its progress screen, and the statuses they move through.
audience: [developer, central-it]
type: written
draft: true
---

Each operation has a type, a status and a list of steps. See [operations](/docs/concepts/operations) for what the statuses mean.

## Types

The title column shows the heading on the progress screen. A dash means that the progress screen has no title for the type in this release.

| Type                | Progress screen title        |
| ------------------- | ---------------------------- |
| `site.create`       | Creating Your Site           |
| `site.adopt`        | Adopting Your Site           |
| `site.import`       | Importing Your Site          |
| `import.survey`     | Checking Your Server         |
| `migration.cutover` | Moving Your Site             |
| `estate.assess`     | -                            |
| `site.upgrade`      | Updating Your Site           |
| `site.rollback`     | Rolling Back Your Site       |
| `site.delete`       | Deleting Your Site           |
| `site.restore`      | Restoring to a Moment        |
| `site.purge`        | -                            |
| `site.transfer`     | -                            |
| `config.apply`      | Changing Your Settings       |
| `git.pull`          | Pulling From Your Repository |
| `git.preview`       | -                            |
| `modify.apply`      | Delivering an Edit           |
| `module.install`    | Installing a Module          |
| `module.enable`     | Enabling a Module            |
| `module.remove`     | Removing a Module            |
| `theme.default`     | Changing the Theme           |
| `domain.attach`     | Attaching Your Domain        |
| `access.sync`       | Applying Access Changes      |
| `backup.create`     | Backing Up Your Site         |
| `backup.verify`     | Testing a Backup Restore     |
| `backup.restore`    | Restoring a Backup           |
| `backup.export`     | -                            |
| `env.create`        | Creating an Environment      |
| `env.fork`          | -                            |
| `env.promote`       | -                            |
| `env.delete`        | Deleting an Environment      |
| `preview.create`    | -                            |
| `preview.delete`    | -                            |
| `repair.run`        | -                            |
| `site.repair`       | Repairing Your Site          |
| `node.pair`         | -                            |
| `node.command`      | Adding Your Site to Your Box |
| `fleet.upgrade`     | -                            |
| `repo.install`      | -                            |

## Statuses

`planned`, `awaiting-approval`, `running`, `verifying`, `succeeded`, `failed`, `cancelled`, `rolled-back`.

## Step states

`pending`, `running`, `succeeded`, `failed`, `skipped`.

## Verification states

`pending`, `passed`, `failed`, `not-required`.

## Retry

A failed operation of a retryable type can be retried. The retry is a new operation that records the failed one in `retryOf` (a field that names the earlier operation). Types that cannot be retried return an error that says so.
