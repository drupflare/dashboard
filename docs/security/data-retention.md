---
title: Data retention
description: How long each kind of data is kept after it is created or after an account closes.
audience: [security-reviewer]
type: written
draft: true
---

Retention periods (how long data is kept) that the code sets are stated here. Periods the code does not set are marked not stated yet. Ask Drupflare for them before you rely on them.

## Set in the code

- **Deleted sites.** A deleted site is held for 90 days before its records are removed. See [Delete a site](/docs/guides/sites/delete-and-restore).
- **Sessions.** A session ends after 14 days without use, or 30 days after it started. An organization sign-in session ends after up to 8 hours.
- **Invitations.** An invitation expires after 7 days.
- **Contact verification links.** A link expires after 7 days and works once.
- **API keys.** A key stops at its expiry, which is 30, 90, 180 or 365 days from creation.
- **Site grants.** A grant with an expiry stops at that date. Expired grants stay listed until removed.

## Not stated yet

- Audit rows.
- Usage records.
- Backups after a site is deleted.
- Records after an organization closes. Closing an organization is not available yet. See [Delete your organization](/docs/exit/delete-your-organization).
