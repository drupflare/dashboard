---
title: Fleet link
description: How a self-hosted node pairs with the dashboard, what each signed message carries, and what leaves the node.
audience: [self-hosting-operator, security-reviewer, central-it]
type: written
draft: true
---

The fleet link is the connection between a self-hosted node and the dashboard. It runs over signed messages (messages with a digital signature that shows who sent them). The contract version is 1.1.

## Pairing

The dashboard issues a claim code for a node. A pairing has one of four states: `pending`, `claimed`, `expired` or `revoked`. A pending pairing expires after 15 minutes. The node claims the pairing with the code, and the dashboard stores only a hash (a scrambled form of the code that cannot be read back) of the code.

## Signed messages

Every message is signed with Ed25519 (a digital signature method). Before signing, the message is written in canonical JSON (one fixed, standard way to write the same data). Each kind of signature uses a fixed context string (a label built into the signature), so a signature made for one message type does not verify for another. The contexts are `drupflare.fleet-link.envelope.v1` and `drupflare.fleet-link.challenge.v1`.

A message is refused when its timestamp is more than five minutes from the dashboard's clock.

## What leaves the node

The node sends these fields to the dashboard:

- Status: the node id, the operating system, the CPU architecture, the Bastion and workerd versions, the operating mode, and capacity figures such as sites used and memory.
- Host name: only when the operator allows it.
- Tenant and site names: hashed when the operator chooses.
- Findings: finding codes with a site name and a count.
- Metrics: named numeric samples (measured values) for a window, and the request count.
- Audit head: the length and hash of the audit chain (the log of changes, where each entry is linked to the one before it).
- Usage: hourly view counts for each site.
- Command results: whether each command succeeded, with a result code and deploy metadata (details about the deploy).

The node never sends site content, databases, secrets, environment values or log bodies.

See [what leaves your box](/docs/guides/self-hosted/what-leaves-your-box) and [pair a node](/docs/guides/self-hosted/pair-a-node).
