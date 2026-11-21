---
title: What we store
description: Each kind of data Drupflare keeps, where it lives and how long it stays.
audience: [security-reviewer]
type: written
draft: true
---

This page lists the kinds of data the dashboard keeps. It does not list where each one is stored, because storage locations are not set by jurisdiction. See [Data location](/docs/institutions/data-location).

| Kind                 | What it holds                                                                                | How long it stays                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Account records      | Email address, sign-in identities, sessions                                                  | Sessions end after 14 days idle or 30 days total. See [Data retention](/docs/security/data-retention). |
| Organization records | Organizations, members, invitations, departments, clients, cost centers, procurement records | Until the record is removed. Organization deletion is not available yet.                               |
| Site records         | Site names, settings, environments, domains, backups index, configuration history            | For a deleted site, 90 days. See [Data retention](/docs/security/data-retention).                      |
| Usage records        | Hourly view counts per site, with an accounting state                                        | Collection is not live yet.                                                                            |
| Audit rows           | Who changed what, and when                                                                   | Not stated yet.                                                                                        |
| Trust documents      | Documents published on the trust page                                                        | Until retired by an admin.                                                                             |

## What is not in the dashboard

The dashboard keeps control records. Site content lives on the site itself, and the dashboard does not copy it. The admin consoles (the screens platform staff use) read the dashboard's records. Support access to a site is not documented yet.

Credentials are covered in [Credential handling](/docs/security/credential-handling).
