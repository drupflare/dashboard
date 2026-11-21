---
title: Break glass
description: Admin runbook for emergency access to an organization when no support grant covers the work, and how that access is recorded.
audience: [security-reviewer]
type: written
draft: true
---

Break glass is emergency access. It lets a platform admin into an organization without a support grant. Use it only when the organization has not granted support access, and the work cannot wait for one. For the normal path, see [Support grants](/docs/admin/support-grants).

## Starting a session

- You need the support permission on the platform and a fresh sign-in (one made recently). The start is refused without one.
- Write a reason of 10 to 500 characters. The reason is required.
- A session lasts one hour. An admin can start three sessions per UTC day (a day counted in UTC time).

## What is recorded

When a session starts:

- The start is written to the platform audit log and the organization's audit log, both with the reason.
- Every owner of the organization is emailed once. The response reports how many of those emails went out.
- A break-glass record is kept with the admin, the organization and the reason.

Owners are told once, at the start. They are not emailed on each later use of the session. Read the audit logs to see what was done during a session.
