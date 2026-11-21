---
title: Support grants
description: Admin runbook for the support access an organization grants, how to check that a grant is live, and how it ends.
audience: [developer]
type: written
draft: true
---

A support grant is access that an organization gives Drupflare support for a set time (time-boxed). The organization creates it, not the platform. Admins check grants and work under them. For access without a grant, see [Break glass](/docs/admin/break-glass).

## What the organization chooses

The owner or an admin picks one of two scopes (levels of access):

- **Read Metadata.** Support can see the organization, its sites and its settings. Support cannot change anything or read site content. Support works with the viewer role.
- **Act on the Organization.** Support can also change settings and run operations. Support still cannot read site content. Support works with the developer role.

The grant lasts from one hour to seven days. Creating a grant needs a fresh sign-in. The organization can revoke a grant at any time, but a revoke has to come from a signed-in session. An API key cannot revoke a grant.

## Checking a grant

Open `/admin/support-grants`. It lists the grants that organizations have made. You need the read permission on the platform to see it.

An expired or revoked grant gives no access. Check that the grant is still active before you start work.

## Working under a grant

Support never reads site content under either scope. Every use of a grant is written to the organization's audit log and to the platform audit log.

## When a grant ends

A grant ends at its end time, or earlier when the organization revokes it. Support has no way to extend a grant. If more time is needed, the organization creates a new grant.
