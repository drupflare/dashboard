---
title: Glossary
description: Short definitions of the terms the dashboard uses.
audience: [solo-beginner, developer, central-it]
type: written
draft: true
---

**Alert.** A notification sent when something needs attention. A critical alert is the kind that counts toward Production Ready.

**Backup.** A saved copy of a site's database at one moment. See [backups and recovery](/docs/concepts/backups-and-recovery).

**Bastion.** The software a node runs. It pairs the node with the dashboard. See [install Bastion](/docs/guides/self-hosted/install-bastion).

**CAA record.** A DNS record that names the certificate authorities allowed to issue a certificate for your domain. See [attach a custom domain](/docs/guides/domains/attach-a-custom-domain).

**Cutover.** The point where your address starts pointing at the migrated site. See [cutover and rollback](/docs/guides/migration/cutover-and-rollback).

**DNS.** The system that points a domain name at the address where a site answers. You add DNS records at the company that holds your domain, and see [attach a custom domain](/docs/guides/domains/attach-a-custom-domain).

**Environment.** A copy of a site kept apart from the live site, for testing changes. See [sites and environments](/docs/concepts/sites-and-environments).

**Health.** The state of a site as the dashboard reads it: Healthy, Needs Attention, Starting, Not Responding or Health Unavailable. See [health and repairs](/docs/concepts/health-and-repairs).

**Idempotency key.** A value sent with a write request, in the `Idempotency-Key` header. A repeated request with the same key returns the first result and does not run the change again. See [idempotency](/docs/reference/api/idempotency).

**Node.** A server you run that hosts sites on the self-hosted plane.

**Operation.** One change to a site, such as a create, an update or a restore. Each one has a status and steps. See [operations](/docs/concepts/operations).

**Owner token.** The credential the dashboard holds for a site so it can act on that site. See [ownership and owner tokens](/docs/concepts/ownership-and-owner-tokens).

**Plane.** Where a site runs and who holds its infrastructure: managed, self-managed or self-hosted. See [choose a plane](/docs/start/choose-a-plane).

**Point-in-time recovery.** Restoring a site's database to a chosen moment in the last 30 days.

**Preview.** A copy of a site that deletes itself after 1, 3, 7 or 14 days. See [temporary previews](/docs/guides/code/temporary-previews).

**Quarantine.** The state a site enters after repeated failures on the same problem. See [quarantine](/docs/troubleshooting/quarantine).

**Readiness.** The Live, Verified and Production Ready levels. See [readiness](/docs/concepts/readiness).

**Release.** One version of a site's code. See [releases and rings](/docs/concepts/releases-and-rings).

**Repair.** A named action the platform takes to fix a known problem on a site. See [health and repairs](/docs/concepts/health-and-repairs).

**Restore point.** A moment a site can be restored to. It is either a backup or a point in the point-in-time window.

**Ring.** One of six groups, R0 to R5, that a release rolls out through in order. See [releases and rings](/docs/concepts/releases-and-rings).

**Route class.** The group of API endpoints a call belongs to. Each group has its own rate limit. See [rate limits](/docs/reference/api/rate-limits).

**Showback.** A report of each cost center's share of the organization's spend. It does not send invoices. See [cost centers and showback](/docs/guides/billing/cost-centers-and-showback).

**Site.** One Drupal or Worker app with one address.

**Strata.** An optional add-on for Drupal sites that keeps a history of changes, so you can browse and restore one field's history. See [Strata](/docs/guides/data/strata).

**Template.** A ready-made starting point for a new site.

**Webhook.** A web address that another system gives you, so Drupflare can send it messages about events. Drupflare defines its webhook events but does not deliver them yet. See [destinations and webhooks](/docs/guides/notifications/destinations-and-webhooks).
