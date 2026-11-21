---
title: Destinations and webhooks
description: Where Drupflare sends mail today, and the webhook events it defines but does not deliver yet.
audience: [developer]
type: written
draft: true
---

This page lists where Drupflare sends mail and the webhook events it defines. It is for owners who set up alerts.

Mail goes to email addresses only. Drupflare has no chat destination.

An organization keeps four contacts, one for each role: technical, billing, legal and recovery. Each contact is an email address. A contact is confirmed when its owner follows the link Drupflare sends to that address. Until then no test can reach it.

Budget alerts also go to the owners and billing members of the organization, and to the verified billing contact.

## Webhooks

Drupflare defines five webhook events (automatic messages about things that happen on a site) in its contract: `operation.succeeded`, `operation.failed`, `site.state.changed`, `backup.verified` and `release.published`. Each carries the organization ID and a typed payload.

Drupflare does not deliver them. No setting takes a webhook URL, and nothing sends the events to one. The API reference says the same. Do not build an integration that waits for these events.
