---
title: Token permissions
description: The minimum Cloudflare token permissions a self-managed site needs, and why each one is needed.
audience: [developer, security-reviewer]
type: written
draft: true
---

A self-managed site needs a Cloudflare API token that can reach six capabilities on one account. The connect check reads each capability and reports the permission to add when one is missing.

## Permissions

| Capability         | Permission name                                                           | Why the site needs it                            |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------ |
| Site scripts       | Workers Scripts Edit                                                      | Uploads and updates the code that runs the site. |
| Key-value storage  | Workers KV Storage Edit                                                   | Keeps small site settings.                       |
| Object storage     | Workers R2 Storage Edit                                                   | Keeps uploaded files and backups.                |
| Databases          | D1:Edit                                                                   | Holds site data.                                 |
| Domains and routes | Workers Routes Write                                                      | Points a hostname at the site.                   |
| Token management   | Account API Tokens Write (account token) or API Tokens Write (user token) | Creates the narrower token the site uses later.  |

The template link on the connect page prefills these permissions. The permission keys in the template are `workers_scripts`, `workers_kv_storage`, `workers_r2`, `d1`, `workers_routes` and `account_api_tokens`, all set to edit.

## The token Drupflare keeps

When the token you give has the token management permission, Drupflare makes a narrower token with the first five permissions in the table and keeps only that one. The narrower token has no token management permission, so it can't make or delete tokens. The token you gave isn't kept. When the token you give has no token management permission, Drupflare keeps that token as it is, and it keeps every permission you gave it. Give it only the permissions in the table.

## What the check reads

The check reads one endpoint per capability, using the first account the token can list:

- Site scripts: the account's script list.
- Key-value storage: the account's namespace list.
- Object storage: the account's bucket list.
- Databases: the account's database list.
- Domains and routes: the account's custom domain list.
- Token management: the permission groups for account tokens, or for user tokens.

A read shows whether the token can make that read. The check sends the read with the permission named above, so a read that Cloudflare refuses with 403 means that permission is missing. A read that succeeds shows the token can make the read, but the site also needs the edit permission. The check reports the edit permission name because the site writes to each capability.

## Accounts without a payment card

Cloudflare turns on object storage only for an account with a payment card, even when usage stays inside the free allowance. On an account without one, the bucket list fails with error code 10042 and the check shows Object storage as "Not turned on" instead of "Missing". The token is fine in that case, and adding permissions will not change the result.

Until you add a card and turn on R2 in the Cloudflare dashboard, the site runs without object storage. The file mirror and Strata backups to R2 stay off, and every other capability works. Check again after you turn R2 on.

## Endpoints not confirmed

The check relies on a few endpoints that Cloudflare's reference did not confirm during the build:

- The HTTP status Cloudflare uses with code 10042. The check reads the code and accepts status 400 or 403.
- The account verify endpoint for account tokens. The check does not call it. It recognises an account token by the `cfat_` prefix, or by a refused user check.
- The account list endpoint, the object storage bucket list, the database list and the custom domain list. Each follows the path shape of a confirmed endpoint on the same account, but the list call itself is not confirmed.
- The database permission name `D1:Edit` comes from a reference page that names it in that form.
- The permission group names the connect step looks up when it makes the narrower token: Workers Scripts Write, Workers KV Storage Write, Workers R2 Storage Write, D1 Write and Workers Routes Write, with the matching Edit names tried second. A name the account doesn't list stops the connect, and Drupflare stores nothing.
- The account subdomain read the connect step makes to find your workers.dev address. It reads `result.subdomain` from the account's Workers subdomain endpoint.
- The call that turns on a script's workers.dev address.

Each unconfirmed endpoint needs a check against a live account before this guide leaves draft.
