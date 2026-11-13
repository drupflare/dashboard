---
title: Attach a custom domain
description: Point your own domain at a Drupflare site and confirm it is live.
audience: [solo-beginner, nonprofit]
type: written
draft: true
---

A managed site always answers at its own address under `drupflare.app`. Attaching a custom domain adds a second address that you own, such as `www.example.edu`. The site keeps its Drupflare address while you set the new one up.

## Status

The stages, the DNS records, the page and the checks are built and tested against a stand-in for the certificate service. A real attach needs two things Drupflare has not turned on yet: Cloudflare for SaaS on the Drupflare account, and a zone and target name for custom domains. Until then, an attach stops at the first step and says custom domains are not turned on. Nothing is created and nothing is left behind.

## What you can attach

Any domain you control, with a name such as `www.example.edu`. Drupflare refuses:

- Any name under `drupflare.app` or `drupflare.com`. Drupflare keeps those for its own sites.
- A name that starts with `*`.
- An address that is not a domain name, such as an IP address.
- A domain another site on Drupflare already holds. If that site is deleted, the domain becomes free.

Only a live managed site can take a domain. Starting an attach needs a signed-in session with a recent step-up, so an API key cannot start one. Only organization owners and admins, and site admins, can start or read it.

## The four stages

The domain page shows four stages. They run in order, and each one needs its own proof before the next opens.

1. **Ownership Check.** You add an ownership record at your DNS provider. Drupflare looks for it every few minutes.
2. **Secure Certificate.** You add a certificate record. This stage opens only after the ownership check is done, and it finishes when the certificate is issued.
3. **Routing.** Drupflare sends visitors of the domain to your site. You do nothing here.
4. **Final Check.** You add the address record that points the domain at Drupflare. Drupflare then loads your site through the domain, and the stage finishes when the site answers.

You can add all three records at once. The page lists each record with its type, name and value, and says what it is for. Add them exactly as shown.

If your DNS provider will not take an address record on the bare domain, such as `example.edu`, ask it for an ALIAS or ANAME record with the same target.

## While it waits

Drupflare checks every 30 seconds for the first five minutes, then every five minutes for about two and a half hours, then every half hour. It waits up to 72 hours for your DNS. If the records have not appeared by then, the attach stops with a plain reason and takes back what it made: the claim on the domain, the route, and the entry at the certificate service. Attach the domain again once the records are in place.

A site allows one open change at a time, so an update or a backup waits while an attach is open. The attach holds the site's lock only while it works, not while it waits for your DNS.

## When it stops

Each reason reads in plain words on the page. The common ones:

- **Another site already holds this domain.** Remove it from that site first, or use a different domain.
- **The domain could not be confirmed as yours.** Check the ownership record, then attach again.
- **The certificate could not be issued.** Check the certificate record and any CAA records at your DNS provider, then attach again.
- **The site did not answer through the domain.** Check the address record, then attach again.

A stopped attach shows its records again, and the form is ready for another try. A new try gets a new claim on the domain.

## If a domain changes hands

A domain belongs to one site at a time. When the site that held it is deleted, another organization can claim it. The moment that claim succeeds, the old site stops serving the domain. An attach that was still running for the old site cannot route the domain afterward: it checks its claim before every write and stops when the claim has moved on.
