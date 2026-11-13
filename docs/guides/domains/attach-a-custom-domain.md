---
title: Attach a custom domain
description: Point your own domain at a Drupflare site and confirm it is live.
audience: [solo-beginner, nonprofit]
type: written
draft: true
---

A managed site always answers at its own address under `drupflare.app`. Attaching a custom domain adds a second address that you own, such as `www.example.edu`. The site keeps its Drupflare address while you set the new one up.

## Status

The page, the DNS checks and the stages are built and tested against stand-ins for DNS and for the certificate service. A real attach needs two things Drupflare has not turned on yet: Cloudflare for SaaS on the Drupflare account, and a target name for custom domains. Until then you can still prove you own the domain. The attach then stops in a waiting state and keeps your proof, so nothing is lost when custom domains go live.

## What you can attach

Any domain you control, with a name such as `www.example.edu`. Drupflare refuses:

- Any name under `drupflare.app` or `drupflare.com`. Drupflare keeps those for its own sites.
- A name that starts with `*`.
- An address that is not a domain name, such as an IP address.
- A domain another site on Drupflare already holds. If that site is deleted, the domain becomes free.

Only a live managed site can take a domain. Starting an attach needs a signed-in session with a recent step-up, so an API key cannot start one. Only organization owners and admins, and site admins, can start it. The record check needs a signed-in session too, but no step-up, because it changes nothing.

## See the records first

Type the domain and press Show Records. The page lists every record to add, each with its type, name and value, and reads your DNS live to mark each one as found, not found yet, found with a different value, or could not be checked right now. A lookup that fails is never reported as a missing record. The page checks again every 20 seconds while you keep it open, so you can add a record and watch it turn green.

You add two records yourself:

- **Ownership.** A TXT record at `_drupflare-challenge.` followed by your domain, with a value that starts with `drupflare-verify=`. The value is specific to your site, your domain and this attempt. A copy of it on another site, another domain or a later attempt does not count.
- **Address.** A CNAME record that points your domain at the Drupflare target name.

Drupflare does not offer A or AAAA records, because no fixed address list is set up for the target.

Once the certificate service has been asked, two more records appear: one that confirms the domain to the certificate service and one for the certificate itself. Add them as shown.

The check also warns about things that block a setup before they do:

- A CNAME record on a bare domain such as `example.edu`. DNS does not allow it beside the records every bare domain has. Ask your provider for an ALIAS or ANAME record with the same target.
- Other A, AAAA or CNAME records on the name that send visitors somewhere else.
- A CAA record that does not allow `letsencrypt.org`, `pki.goog` or `ssl.com`. Those are the authorities the certificate service issues from.
- An old ownership value left at the name next to the current one. The current one still counts, but remove the old one.

If another site holds the domain and has proven it, the page says so and lists no records. If another site asked for the domain but never proved it, the page lists your records as usual. Publish the ownership record first and check that it is found, because pressing Attach Domain takes the name only when your record is already in DNS at that moment.

## The four stages

The domain page shows four stages. They run in order, and each one needs its own proof before the next opens.

1. **Ownership Check.** Drupflare reads your ownership record from DNS. It does not ask the certificate service anything until this passes.
2. **Secure Certificate.** Drupflare asks the certificate service to take the domain, and this stage finishes when the certificate is issued.
3. **Routing.** Drupflare waits for your address record to appear, then sends visitors of the domain to your site.
4. **Final Check.** Drupflare loads your site through the domain, and the stage finishes when the site answers.

You can add every record at once.

## While it waits

Drupflare checks every 30 seconds for the first five minutes, then every five minutes for about two and a half hours, then every half hour. It waits up to 72 hours for each stage. If a record has not appeared by then, the attach stops with a plain reason and takes back what it made: the claim on the domain, the route, and the entry at the certificate service. Attach the domain again once the records are in place.

While the attach waits for the ownership record, the page says Waiting for Your DNS Record and shows the date Drupflare stops waiting. A site allows one open change at a time, so an update or a backup waits while an attach is open, for as long as 72 hours. The attach holds the site's lock while it works and lets go while it waits for your DNS.

Press Cancel This Attach if you typed the wrong name or no longer want it. The name is free for any site to claim, and the site accepts other changes again once the attach reads its claim at the next check, which is within 30 seconds in the first five minutes and within half an hour at the latest. Cancel works until the certificate service has been asked for the domain. After that, the domain is set up and Cancel is refused. A verified name that is parked while custom domains are off can be cancelled the same way.

## When custom domains are off

If the ownership check passes but custom domains are not switched on for Drupflare, the page shows a waiting state in place of an error. Your domain is verified, nothing is attached, and the page shows Try Again.

Try Again starts the attach from your proof. It skips the ownership check, so you can remove the ownership record once the domain is verified and the attach still finishes. The proof lasts until the claim is released or the domain moves to another site. A new claim needs a new record.

## When it stops

Each reason reads in plain words on the page. The common ones:

- **Another site already holds this domain.** Remove it from that site first, or use a different domain.
- **Another site asked for this domain first but has not proven it.** Add the ownership record shown on the page, check that it is found, then attach again.
- **Another site proved ownership of this name.** The name is no longer reserved for your site and the attach stopped.
- **You cancelled this attach.** The name is no longer reserved for your site.
- **The domain could not be confirmed as yours.** Check the ownership record against the value on the page, then attach again.
- **The certificate could not be issued.** Check any CAA records at your DNS provider, then attach again.
- **The site did not answer through the domain.** Check the address record, then attach again.

A stopped attach shows its records again, and the form is ready for another try. A new try gets a new claim on the domain and a new ownership value, so add the new value and remove the old one.

## If a domain changes hands

A domain belongs to one site at a time. A site that asks for a domain without proving it holds the name for up to 72 hours, and only until someone else proves it. When another site publishes its own ownership record and attaches, it takes the name, and the earlier request stops with a plain reason that does not say who took it. A site that already proved the domain keeps it. When the site that held it is deleted, another organization can claim it. The moment that claim succeeds, the old site stops serving the domain. An attach that was still running for the old site cannot route the domain afterward: it checks its claim before every write and stops when the claim has moved on.

Deleting a site also releases its domains: the route, the certificate service entry and the claim. If the certificate service refuses to remove an entry, the delete notes which domain it kept, and the claim stays so a later run can finish the job.
