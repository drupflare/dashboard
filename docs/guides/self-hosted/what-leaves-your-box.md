---
title: What leaves your box
description: The data a paired bastion sends to the dashboard, and the data that never leaves the box.
audience: [self-hosting-operator, security-reviewer]
type: written
draft: true
---

This page lists the data a paired Bastion sends to the dashboard and the data that stays on your box. It is for owners who run a node.

A paired bastion (the software a node runs) sends the dashboard a fixed set of fields. Each message is signed, and the dashboard refuses a message whose timestamp is more than five minutes from its own clock.

## What the box sends

- **Status.** The node id, the host name (only when you allow it), the operating system and the CPU architecture. It also sends the bastion and workerd versions, the operating mode, the tenant and site names (hashed when you choose), and capacity numbers such as sites used and memory.
- **Findings.** Finding codes with a site name and a count. Never content.
- **Metrics.** Named numeric samples for a time window, and the request count for that window. Never log bodies.
- **Audit head.** The length of the audit chain and its head hash.
- **Usage.** Hourly view counts for each site, with the report id, the sending component and the send time.
- **Command results.** For each command, the operation and step it belonged to, its [idempotency key](/docs/start/glossary), whether it succeeded, a result code, and the deploy version and time when there was one.

## What never leaves the box

- Site content
- Databases
- Secrets
- Environment values
- Log bodies

## What the dashboard sends the box

The dashboard sends commands for the box to run, and a list of sites with their host names.
