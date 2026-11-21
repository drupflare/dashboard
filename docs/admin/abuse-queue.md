---
title: Abuse queue
description: Admin runbook for working through reports of abuse, suspending a reported site and lifting a suspension.
audience: [developer]
type: written
draft: true
---

The abuse queue is on the admin Abuse page at `/admin/abuse`. Reports move through four states:

- **Open.** New reports. You can move a report from open straight to actioned or dismissed.
- **Reviewing.** Someone has picked the report up. A reviewing report can go back to open, or on to actioned or dismissed.
- **Actioned.** Final. Use it when you have acted on the report.
- **Dismissed.** Final. Use it when the report is not a problem.

Any other move is refused. Each state change writes an audit row (a log entry of who changed what).

## Suspending a reported site

Suspend Site on an open or reviewing report:

- suspends the reported site through the site's authority, so visitors stop reaching it,
- emails the owners of the organization. This is essential security mail, so owners cannot opt out of it,
- writes an audit row on the platform and one on the organization,
- closes the report as actioned.

A repeat for the same report returns the same operation and sends nothing more. A dismissed report cannot suspend a site, and the request is refused.

## Lifting a suspension

An admin lifts a suspension with the unsuspend action for the site. It needs the support permission and a fresh sign-in. The owners are emailed, and both audit logs record the change. Only a suspension lifts. A revoked site stays revoked.

A budget change does not lift a suspension. The budget stops keep their own state, and they leave a suspended site suspended. See [Budget enforcement](/docs/admin/budget-enforcement).

The queue holds the reports and their state. Record your reason in the report before you close it.
