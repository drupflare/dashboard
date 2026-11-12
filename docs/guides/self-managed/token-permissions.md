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

## What the check reads

The check reads one endpoint per capability, using the first account the token can list:

- Site scripts: the account's script list.
- Key-value storage: the account's namespace list.
- Object storage: the account's bucket list.
- Databases: the account's database list.
- Domains and routes: the account's custom domain list.
- Token management: the permission groups for account tokens, or for user tokens.

A read shows whether the token can make that read. The check sends the read with the permission named above, so a read that Cloudflare refuses with 403 means that permission is missing. A read that succeeds shows the token can make the read, but the site also needs the edit permission. The check reports the edit permission name because the site writes to each capability.

## Endpoints not confirmed

The check relies on a few endpoints that Cloudflare's reference did not confirm during the build:

- The account verify endpoint for account tokens. The check does not call it. It recognises an account token by the `cfat_` prefix, or by a refused user check.
- The account list endpoint, the object storage bucket list, the database list and the custom domain list. Each follows the path shape of a confirmed endpoint on the same account, but the list call itself is not confirmed.
- The database permission name `D1:Edit` comes from a reference page that names it in that form.

Each unconfirmed endpoint needs a check against a live account before this guide leaves draft.
