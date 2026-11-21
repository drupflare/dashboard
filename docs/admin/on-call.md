---
title: On call
description: Admin runbook for the on-call rota and the first steps for a page.
audience: [developer]
type: written
draft: true
---

The on-call rota (the schedule of who is on call) is not in this documentation. Not available yet.

First steps when something pages you (sends you an alert):

1. Open the admin Overview at `/admin` and the Operations page at `/admin/operations`. Look at operations that are failed or in flight.
2. Check the Flags page at `/admin/flags`. A platform switch may have stopped sign-ups or rollouts on purpose.
3. Check the Releases page at `/admin/releases` for a rollout in progress.

Record what you saw and what you changed. Use the runbook (a step-by-step guide) that matches the problem: [Ring halt](/docs/admin/ring-halt), [Release promotion](/docs/admin/release-promotion) or [Shard failure](/docs/admin/shard-failure).
