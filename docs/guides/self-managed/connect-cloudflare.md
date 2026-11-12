---
title: Connect Cloudflare
description: Connect your own Cloudflare account so the dashboard can manage a self-managed site.
audience: [developer, self-hosting-operator]
type: written
draft: true
---

The connect step checks a Cloudflare API token before anything is stored or created. It tells you which parts of your account the token can reach, and which permissions are missing.

## Run the check

1. Open the connect page and select **Create a Token With These Permissions**. Cloudflare opens its token form with the permissions prefilled. Review them, then create the token.
2. Paste the token into the connect page and select **Check This Token**.
3. If the token can see more than one account, pick the account to check and select **Check This Account**.

The check sends read requests to the Cloudflare API. It does not write to your account.

## What the check proves

The report covers three things.

- **Token status.** Whether Cloudflare accepts the token, and whether it is active, expired or turned off. A token that Cloudflare accepts for user requests is reported as a user token. A token with the `cfat_` prefix is reported as an account token. A token without the prefix that Cloudflare refuses on the user check is reported as an account token.
- **Accounts.** The accounts the token can list. The check uses the first account unless you pick another.
- **Capabilities.** For the chosen account, one read per capability. A read that succeeds means the token has that capability at the time of the check. A read that Cloudflare refuses with a 403 means the permission is missing. Any other answer, such as a timeout, a server error or a rate limit, is reported as not checked, and you can run the check again.

The check does not prove that a later request will succeed. Permissions can change after the check, and a read does not exercise every write the site needs.

## What the check does not do

- It does not store the token. The token stays in the page until you leave it.
- It does not create, change or delete anything in your account.
- It does not send the token anywhere except the Cloudflare API.
- It does not decide whether the token will be kept for later use. Storing and narrowing a token are separate steps.

## Limits

- The check makes at most 12 requests and waits at most 10 seconds for each one.
- The report marks a capability as not checked when Cloudflare does not answer. It does not guess.
- Some read endpoints used by the check are not confirmed against Cloudflare's reference. See [token permissions](./token-permissions.md) for the list.
