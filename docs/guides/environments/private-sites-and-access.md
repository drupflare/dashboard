---
title: Private sites and access
description: Decide who can open a site or environment, with rules for members, invited email addresses, named accounts, passwords and review links.
audience: [developer, agency]
type: written
draft: true
---

This page shows you how to set access rules that decide who can open a site. It is for site owners and admins.

A site's access rules decide who can open it. Rules apply to the production site or to one of its environments. A visitor who matches any one rule gets in.

## Rule types

The access page lists the types your plan includes. The types are:

- **Members.** Your organization's members with at least viewer access.
- **Grants.** People and groups that hold a site grant, including delegated agencies.
- **Invited email addresses.** Each person gets a one-time code by email.
- **Named GitHub or GitLab accounts, and GitHub organizations or GitLab groups.** Each person signs in with that provider.
- **Single sign-on.** Your organization's identity provider. It needs single sign-on set up first.
- **Password.** One shared password. To replace it, remove the rule and add another.
- **Review link.** A link that stops working after a set time. Useful for a client review.
- **Public.** Everyone can open the site. This is the default for production.

Passwords and link tokens are stored as hashes. A review link's token is shown once, when you create the rule. Copy it then.

## Add a rule

Open the site's Access page and add a rule. The rule is saved first. If the site has not picked up a saved rule yet, use the option to apply the saved rules again. It starts an operation that writes them to the site.

## Public and private

A production site with no rules is public. Adding a rule other than Public makes the site private, so only visitors who match a rule get in. Public is a rule of its own, and it lets everyone in.

## Limits

- The number of invited email addresses is limited by your plan. The access page shows the limit.
