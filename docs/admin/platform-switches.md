---
title: Platform switches
description: Admin runbook for the platform switches on the Flags page, what each one stops and who can change them.
audience: [developer]
type: written
draft: true
---

Platform switches are on/off settings that apply to the whole platform. The Flags page at `/admin/flags` shows them. Each change is written to the audit log with the admin who made it.

## The switches

| Switch                 | What it does while on                                                             |
| ---------------------- | --------------------------------------------------------------------------------- |
| Pause Sign-ups         | Stops new accounts from being created. Existing people still sign in.             |
| Pause Optional Mail    | Stops optional mail. Essential mail, such as sign-in codes, still goes out.       |
| Stop Release Promotion | Refuses to start a release rollout, and stops a running one before its next ring. |
| Automatic Repair       | Lets the repair ladder run fixes on its own.                                      |

Turning Automatic Repair on or off needs the confirmation word (the word you type to confirm). The other switches do not.

## Who can change them

Changing a switch needs the infrastructure permission on the platform and a fresh sign-in. The admin role carries that permission. Reading the switches needs the read permission.

A switch keeps its state until an admin changes it. For a failing release, see [Ring halt](/docs/admin/ring-halt).

The budget stops do not use a platform switch. Each budget sets its own enforcement. See [Budget enforcement](/docs/admin/budget-enforcement).
