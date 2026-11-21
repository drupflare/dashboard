---
title: Domain stuck
description: Why a custom domain stops at one of its four stages, what each stage needs from you, and how to restart the attach.
audience: [developer, agency, department-owner, central-it]
type: written
draft: true
---

This page helps you find which stage of a domain attach is stuck, and why. It is for site owners.

Attaching a domain goes through four stages: Ownership Check, Secure Certificate, Routing and Final Check. A stage that is stuck shows **Waiting** or **Pending**. A stage that failed shows the reason next to it.

## Ownership Check

Add the ownership record from the page at your DNS provider (the company that runs your domain's DNS settings). Drupflare looks for it every few minutes. The record shows as **Found** once it is seen, and as **Not found yet** until then.

If the record shows **Found with a different value**, another value sits at the same name. Remove the old value and keep the one shown.

## Secure Certificate

A certificate authority (the company that issues security certificates) decides whether it may issue one for your domain. Your domain's CAA records (DNS settings that name the authorities allowed to issue certificates) can block that. If they do not allow the authorities Drupflare uses, the attach stops. Add the authorities the page lists, or remove the CAA records.

## Routing

Point the domain at Drupflare with the record shown. A bare domain (one with no www in front) may not accept an alias record at its root. If your DNS provider offers an ALIAS, ANAME or flattened CNAME record, use it with the same target. If it offers none, use the `www` version of the domain instead.

## Attach refused

Some reasons stop an attach right away:

- **Another site holds the domain.** Remove the domain from that site first, or use a different domain.
- **Another site asked for the domain first and has not proven ownership.** Add the ownership record on this page, check that it is found, and attach again.
- **Custom domains are off for this account.** Nothing is attached. Try again later.

## Restart the attach

Choose **Try Again** on the domain page after you fix the cause. The attach continues from the proof it already has.

See [domains and names](/docs/concepts/domains-and-names) and [domain states explained](/docs/guides/domains/domain-states-explained).
