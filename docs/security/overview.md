---
title: Security overview
description: How Drupflare protects accounts, sites and data, in one page.
audience: [security-reviewer]
type: written
draft: true
---

This page sums up how Drupflare protects accounts, sites and data. Each section links to more detail.

## Accounts

- Sessions end after 14 days without use, and after 30 days in total. Sign-in through an organization's identity provider lasts up to 8 hours. See [Credential handling](/docs/security/credential-handling).
- Sensitive actions, such as changing a domain or accepting a transfer, ask the signed-in person to confirm again. This is a step-up check.
- Organization sign-in works with OpenID Connect (a standard sign-in protocol). See [Single sign-on](/docs/guides/teams/sso).

## Access

- Every request is checked against the person's organization role and any site grants. See [Roles and permissions](/docs/guides/teams/roles-and-permissions).
- API keys have a set of actions and an expiry. They cannot change keys or use actions that need a signed-in session.
- Many changes, including member, site, sign-in and key changes, write audit rows (log entries that record who changed what). An organization-facing audit page is not available yet.

## Data

- The dashboard stores control records: organizations, members, sites, billing and audit rows. These are the dashboard's own records, not site content. See [What we store](/docs/security/what-we-store).
- Retention is covered in [Data retention](/docs/security/data-retention).
- Subprocessors are listed in [Subprocessors](/docs/security/subprocessors).

## Reporting and reviews

Report a problem through [Responsible disclosure](/docs/security/responsible-disclosure). For a review, start with the [security review packet](/docs/institutions/security-review-packet).
