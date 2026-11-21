---
title: Webhooks
description: The webhook endpoints the platform receives, how it checks their signatures, and the events the contract defines for outbound delivery.
audience: [developer, self-hosting-operator]
type: written
draft: true
---

A webhook is an automatic message one service sends to another when something happens. Webhooks run in two directions. This page covers both.

## Incoming

The platform receives webhooks from three senders. Each one is checked against a signature (a checksum that proves who sent it) before anything in the body is read.

- **Stripe.** Billing events. The request must carry a valid `Stripe-Signature` header. Bodies larger than 1 MB are refused.
- **GitHub.** Repository events for connected repositories. The request must carry a valid `X-Hub-Signature-256` header.
- **Release.** Release announcements from the platform's own release process. The request must carry a valid `X-Drupflare-Signature` header.

A request with a missing or invalid signature is refused.

## Outbound events

The contract defines these event types (kinds of event) for webhooks the dashboard sends to your endpoint:

- `operation.succeeded`
- `operation.failed`
- `site.state.changed`
- `backup.verified`
- `release.published`

Delivery of outbound events is not yet live in this release. The event shapes (the fields each event carries) are fixed by the contract, so you can plan an integration against them. Each event has a `v` field set to the major version, an `id`, a `type`, a `createdAt` time, an `orgId` and a `data` object.

See [contracts and versioning](/docs/reference/contracts-and-versioning) for how the event shapes change.
