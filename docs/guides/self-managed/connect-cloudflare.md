---
title: Connect Cloudflare
description: Connect your own Cloudflare account so the dashboard can create and manage sites in it.
audience: [developer, self-hosting-operator]
type: written
draft: true
---

This page shows you how to connect your Cloudflare account to the dashboard. It is for site owners who run sites in their own account.

Connecting takes two steps. The first checks a Cloudflare API token and stores nothing. The second connects the account and stores a sealed token the dashboard uses later to create, update, roll back and remove sites in that account.

## Check the token

1. Open the connect page and select **Create a Token With These Permissions**. Cloudflare opens its token form with the permissions prefilled. Review them, then create the token.
2. Paste the token into the connect page and select **Check This Token**.
3. If the token can see more than one account, pick the account and select **Check This Account**.

The check sends read requests to the Cloudflare API. It doesn't write to your account and it doesn't keep the token.

## What the check proves

The report covers three things.

- **Token status.** Whether Cloudflare accepts the token, and whether it is active, expired or turned off. A token that Cloudflare accepts for user requests is a user token. A token with the `cfat_` prefix is an account token. A token without the prefix that Cloudflare refuses on the user check is also reported as an account token.
- **Accounts.** The accounts the token can list. The check uses the first account unless you pick another.
- **Capabilities.** For the chosen account, one read per capability. A read that succeeds means the token has that capability at the time of the check. A read that Cloudflare refuses with a 403 is reported as a missing permission. Any other answer, such as a timeout, a server error or a rate limit, is reported as not checked, and you can run the check again.

The check doesn't prove that a later request will succeed. Permissions can change after the check, and a read doesn't exercise every write a site needs.

## Connect the account

Select **Connect This Account** under the report. The button appears only when the token is active and can edit Workers scripts, because a token without that permission can't run a site.

What Drupflare keeps depends on the token.

- **The token can make other tokens.** Drupflare makes a narrower token for this account, named `Drupflare site connection` followed by the connection ID. The narrower token carries only the permissions the check found, and never token management. Drupflare checks that the new token works, keeps only that one, sealed, and doesn't keep the token you pasted. If the new token fails the check, Drupflare deletes it and stores nothing.
- **The token can't make other tokens.** Drupflare keeps the token you pasted, sealed. It keeps every permission you gave it, so use a token that carries only the permissions listed in [token permissions](./token-permissions.md).

The connect step refuses, and stores nothing, in these cases:

- The token has expired or Cloudflare doesn't accept it.
- The token can't edit Workers scripts.
- The token sees more than one account and you didn't choose one.
- This organization has already connected the account.

The sealed token is bound to its connection, so a copy of it can't be opened under another one. The dashboard never shows the token again, in a page, a response or a log.

## Connection states

The Planes page lists each connection with its state, when it was last checked, which token it holds and what that token can use.

- **Active.** The stored token works.
- **Needs Attention.** A check found that the token expired or lost the permission to edit Workers scripts. Sites already in the account keep serving. To manage them again, connect the account again with a new token. The connection keeps its ID, so the sites that name the account work again without any other change.
- **Revoked.** You revoked the connection. Nothing is stored for it.

Select **Check Again** to read the account again. A check that gets no answer from Cloudflare changes nothing.

## Revoke a connection

Select **Revoke** on the Planes page, then type the account name. You need a signed-in session with a recent sign-in, and only organization owners and admins can revoke. An API key can't revoke a connection.

Revoking wipes the stored token. Drupflare can no longer create, update or remove anything in the account. Sites already there keep serving.

If sites still run on the account, the revoke stops and lists them. Tick **Revoke anyway and leave these sites running** to continue. After that, Drupflare can't update or remove those sites until you connect the account again.

What happens to the token in Cloudflare:

- **A token Drupflare made.** Drupflare asks Cloudflare to delete it. The narrower token has no permission to manage tokens, so Cloudflare may refuse. The result then names the token to delete on the API Tokens page of your Cloudflare account.
- **A token you pasted.** It stays in your Cloudflare account. Delete it there if you no longer use it.

## What Drupflare changes in your account

Drupflare writes to your account only for a site it created there, and only the things it recorded for that site. Before each write or delete it checks the site's own record of what it made. A script, key-value namespace, bucket or database that has no record for the site is refused, even when its name looks like one of ours. Drupflare never lists your other resources to change them.

## What the check does not do

- It stores the token only when you select **Connect This Account**.
- It sends the token nowhere except the Cloudflare API.

## Limits

- The check makes at most 12 requests and waits at most 10 seconds for each one.
- The report marks a capability as not checked when Cloudflare doesn't answer. It doesn't guess.
- Some read endpoints and permission group names used by the check and the connect step aren't confirmed against Cloudflare's reference. See [token permissions](./token-permissions.md) for the list.
