---
title: DNS by provider
description: The kinds of DNS record a custom domain needs, and how to find the right menu at your DNS provider.
audience: [solo-beginner, developer]
type: written
draft: true
---

This page shows you which DNS records to add at your provider for a custom domain. It is for whoever manages the domain's DNS.

A custom domain needs three kinds of record at your DNS provider. The Domain page shows the exact name and value for each one. Copy those values. Do not type them from this page, because the values depend on your site.

| Record      | Type                                      | What it does                                 |
| ----------- | ----------------------------------------- | -------------------------------------------- |
| Ownership   | Text (TXT)                                | Proves you own the domain.                   |
| Certificate | Text (TXT) or alias (CNAME), as shown     | Lets Drupflare set up the secure connection. |
| Traffic     | Alias (CNAME) or address record, as shown | Sends visitors to Drupflare.                 |

## Finding the menu

Dashboards at DNS providers use different names for the same record types. Look for DNS records, DNS zones or Manage records in your provider's control panel. Then add a record of the type the Domain page names. Your provider's own help pages have the exact steps, and the Drupflare dashboard does not list them.

## Bare domains

A bare domain, such as `example.org`, cannot hold a plain alias record in most DNS systems. Some providers offer an ALIAS, ANAME or flattened CNAME record for this case. Use it with the target the Domain page shows. If your provider offers none of these, use the `www` version of the domain, which takes a plain CNAME.

## After you add a record

DNS changes can take time to appear. The Domain page shows each record as found, not found yet, or found with a different value. Check the status again after a short wait. See [domain states explained](/docs/guides/domains/domain-states-explained) for what each status means.
