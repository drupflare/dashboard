---
title: First-day checklist
description: The checks behind the Live, Verified and Production Ready levels, and what each one needs from you.
audience: [solo-beginner, nonprofit, department-owner]
type: written
draft: true
---

Each site has a readiness level. The level moves up as checks pass. The site page lists every check and marks it done, open, or not checked yet.

## Live

The site responds to a request. This is the first check, and it passes once the site is serving.

## Verified

- **Admin access verified.** You signed in to the site's admin area.
- **A custom domain verified.** Needed only when the site's intended use needs its own domain.
- **HTTPS verified.** Needed only when the site's intended use needs its own domain.

## Production Ready

- **A backup restored in a test.** Restore a backup into a scratch copy and check that it answers. See [verify a backup](/docs/guides/data/verify-a-backup).
- **A critical alert configured.** Set a critical alert and send a test notification that arrives. See [test your alerts](/docs/guides/notifications/test-your-alerts).
- **Named contacts.** A technical contact, a billing contact and a recovery contact.

## How the level works

The level is worked out each time the page loads. It is not stored. If a check stops holding, the level drops, and the page lists the missing check.
