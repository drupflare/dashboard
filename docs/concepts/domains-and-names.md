---
title: Domains and names
description: Site addresses, the names Drupflare keeps for itself, and the stages a custom domain goes through.
audience: [developer, agency, department-owner, central-it]
type: written
draft: true
---

Every site has an address on `drupflare.app`. To serve the site from a domain you own, attach that domain. See [attach a custom domain](/docs/guides/domains/attach-a-custom-domain).

## Names Drupflare refuses

- A name with a wildcard, such as `*.example.org`. Attach one domain name at a time.
- A name that is not a valid domain.
- A name under `drupflare.app` or `drupflare.com`. Drupflare keeps those zones for its own sites.
- A name that another site already holds.

## Attach stages

An attach runs four stages in order. Each one shows waiting, pending, done or failed.

1. **Ownership Check.** Drupflare checks that you control the domain. You add a record at your DNS provider.
2. **Secure Certificate.** Drupflare gets a certificate so the domain loads over HTTPS.
3. **Routing.** Drupflare sends visitors of the domain to your site. You point the domain at Drupflare with a record.
4. **Final Check.** Drupflare loads the site through the domain.

A stage that fails shows a plain reason beside it. [Domain stuck](/docs/troubleshooting/domain-stuck) covers the common ones.

## Custom domains may be off

Custom domains are not switched on for every account in this release. When yours is off, the attach waits. Nothing is attached, and the page says so. Your proof of ownership is kept, so you can try again later.

## Addresses after delete

When you delete a site, its address is held for 90 days. No other site can take it during that time.
