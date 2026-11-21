---
title: Shard failure
description: Admin runbook for a database shard that stops answering.
audience: [developer]
type: written
draft: true
---

A shard runbook is not written yet. Not available yet.

What is known from the code:

- Organizations are spread across database shards (separate databases, each holding some organizations). A shard that stops answering affects the organizations on it.
- The organization search on the admin Organizations page runs on every shard, so it can fail while one shard is down.
- The dashboard's shards hold control records. Site content is on the sites.

Until the runbook exists, record the shard that is failing, the organizations on it, and the time it started. Escalate to the platform owner. Do not run a manual fix on a shard without that owner.
