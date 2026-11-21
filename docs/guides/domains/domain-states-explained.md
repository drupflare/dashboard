---
title: Domain states explained
description: What each step of a custom domain attach means, what the record statuses say, and what to do when an attach stops.
audience: [solo-beginner, developer]
type: written
draft: true
---

This page explains each state the Domain page shows for a custom domain. It is for anyone attaching a custom domain.

A custom domain goes through four checks on the Domain page. Each check has a state. The page also shows the DNS records it found and the ones it still needs.

Custom domains are not turned on for every Drupflare account yet. If yours is not on, the page says so, and the domain stays verified without an address record. Nothing is attached until custom domains are switched on for your account.

## The four checks

| Check              | What it means                                                                       | When it is done                          |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------- |
| Ownership Check    | Drupflare checks that you own the domain, using a text record at your DNS provider. | You own this domain.                     |
| Secure Certificate | Drupflare gets a certificate, so the domain loads over HTTPS.                       | The certificate is issued.               |
| Routing            | Drupflare sends visitors of the domain to your site, using an address record.       | Visitors of this domain reach your site. |
| Final Check        | Drupflare loads your site through the domain.                                       | Your site answers on this domain.        |

Each check reads as waiting, pending or done. Pending means Drupflare is looking for the record you need to add. It looks every few minutes.

## Record statuses

Each DNS record the page lists has one status:

- **Found.** Drupflare sees the record with the value it expects.
- **Not found yet.** The record is not visible. DNS changes can take a while to show.
- **Found with a different value.** A record of that name exists with another value. Replace it with the value on the page.
- **Could not check right now.** Drupflare could not read DNS. Try again later.

## Problems the page can name

- **Bare domain and alias.** A bare domain, such as `example.org`, cannot hold an alias record next to its other records, such as mail. Ask your DNS provider for an ALIAS, ANAME or flattened CNAME record with the same target. If it offers none, use the `www` version of the domain.
- **Conflicting records.** The name already points somewhere else. Replace that record with the one on the page, or visitors keep reaching the old place.
- **CAA records.** Your domain allows only certain certificate authorities to issue certificates. Add records for the authorities the page names, or remove the CAA records. Otherwise Drupflare cannot get a certificate.
- **Second ownership value.** More than one ownership value sits at the ownership record name. Remove the old values and keep the one on the page.

## When an attach stops

The page shows the reason for a stopped attach in plain words. The common ones are:

- Another site already holds the domain. Remove it from that site, or use a different domain.
- Another site asked for the domain first and has not proven it. Add the ownership record, check that it is found, then attach again.
- The records did not appear in time. Add them at your DNS provider, then attach the domain again.
- The domain was confirmed, but the site did not answer through it. Check the address record, then attach again.

A held name stays reserved for your site until the date the page shows. Cancel the attach if you typed the wrong name. A cancelled attach releases the name.

For a step-by-step attach, see [attach a custom domain](/docs/guides/domains/attach-a-custom-domain). For the records at common providers, see [DNS by provider](/docs/guides/domains/dns-by-provider).
