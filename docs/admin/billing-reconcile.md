---
title: Billing reconcile
description: Admin runbook for matching billing records against usage records.
audience: [developer]
type: written
draft: true
---

A reconcile screen (a screen that matches two sets of records to check they agree) is not available yet. Matching billing records against usage records is a manual check for now.

What exists:

- The Capacity page at `/admin/capacity` shows credits, usage and headroom (how much room is left before a limit) when billing access is set up. Without it, the page says so.
- The usage collector is not live in production. Until it is, usage records do not exist for most sites, so there is nothing to match.

Do not reconcile against zero. A missing usage record is not a zero. Record the gap, and reconcile after the usage collector runs.

Decisions about charges and credits are not part of this runbook.
