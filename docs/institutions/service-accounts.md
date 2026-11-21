---
title: Service accounts
description: Create an account for automated work, give it keys that expire, and disable it when the work ends.
audience: [developer, central-it]
type: written
draft: true
---

A service account is an account for automated work, such as a deploy script or a sync job. It is not a person. Each one has an owner, who must be a member of the organization.

Owners and admins manage service accounts at `/org/service-accounts`.

## Creating an account

Give the account a name and an expiry in days. The expiry can be at most 365 days from the day you create the account. The owner is you unless you name another member. When the expiry passes, the account stops issuing keys.

## Keys

An account issues keys (the secret strings that scripts send to the API). A key's expiry cannot be later than the account's expiry.

An account cannot issue a key while its owner is outside the organization. If the owner leaves, hand the account to someone else first.

## Disabling an account

Disabling an account revokes its keys first and then blocks new ones. Any work that used one of its keys stops at that point. Set up a new account if the work has to continue.

## When someone leaves

Removing a member from the organization asks what to do with the service accounts that person owns. You can name another member to take them over. Without a name, the accounts are disabled.
