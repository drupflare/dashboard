---
title: Roles and permissions
description: What each role can do in an organization and on a site.
audience: [developer, department-owner]
type: written
draft: true
---

This page explains which organization role and site role to give someone. It is for owners and admins.

Every person in an organization has one organization role. A site can also give a person a site role, which adds access to that one site. A person's access is the combined set of both.

## Organization roles

| Role      | Can do                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner     | Everything below, plus the billing role's actions, sign-in settings, accepting a site transfer and making an admin.                                                   |
| Admin     | Manage members and invitations, site grants, delegations, client workspaces, cost centers, procurement records, policies and release rollouts. Cannot change billing. |
| Developer | Deploy, roll back and change code, manage repositories, templates, modules, imports and API keys. Cannot manage members.                                              |
| Billing   | View and change billing, open the billing portal, and read usage and cost centers.                                                                                    |
| Viewer    | Read sites, operations, releases, integrations and policies. Cannot change anything.                                                                                  |

An admin cannot make someone an admin or remove the billing role. Only an owner can. Nobody can give a role that holds more actions than their own.

## Site roles

A site grant gives one person one of these roles on one site. See [Site grants](/docs/guides/teams/site-grants).

| Site role  | Can do                                                                     |
| ---------- | -------------------------------------------------------------------------- |
| Site admin | Change site settings, domains, access and grants, and restore backups.     |
| Maintainer | Deploy, roll back, install and remove modules, run backups, and read logs. |
| Viewer     | Read the site, its environments, restore points and repair history.        |

## Actions that need more than a role

Some actions need a step-up check, which asks the signed-in person to confirm again. Some actions can only be done from a signed-in session. API keys cannot perform those. See [API keys](/docs/guides/teams/api-keys).
