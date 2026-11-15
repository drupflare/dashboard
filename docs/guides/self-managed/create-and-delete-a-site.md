---
title: Create and delete a site
description: Create, update, roll back and remove a site in your own connected Cloudflare account.
audience: [developer, self-hosting-operator]
type: written
draft: true
---

A site in your own Cloudflare account uses the same screens as a managed site. Drupflare runs it in your account with the token you connected, so connect the account first. See [connect Cloudflare](./connect-cloudflare.md).

## Create a site

Open **Create in Your Cloudflare Account**. The form appears once the organization has an active connection.

1. Choose the account, if you connected more than one.
2. Choose the site type and a name.
3. Choose the address.
4. Select **Create**.

The create runs as an operation, and the progress page shows each step.

### Address

- **Your Cloudflare address.** The site runs at `s-` followed by the site ID, then your account's workers.dev subdomain. The full address shows when the create finishes. If the account has no workers.dev subdomain, set one in Cloudflare under Workers, or use a hostname of your own. If the subdomain changes between the form and the create, the create stops before it makes anything, and tells you to connect again.
- **A hostname on a domain in this account.** Give the hostname and the zone ID of the domain, which you can copy from the zone overview in Cloudflare. Drupflare adds one route for that hostname to your zone and changes no other record. It reads the zone's routes first and stops if another script already holds that pattern.

### Storage

If the account has object storage on, the site runs the standard setup. If it doesn't, the site runs a simpler setup without file mirroring and without Strata off-site backups. The form says so before you create. Turning on object storage needs a payment card on the Cloudflare account. See [token permissions](./token-permissions.md).

### Steps a self-managed create skips

Some managed steps belong to the Drupflare platform, not to your account. A self-managed create leaves them out and doesn't list them in its plan.

- **Name reservation.** Names are reserved in Drupflare's own registry. Your address comes from Cloudflare.
- **Site authority and the hosts table.** These route Drupflare-hosted addresses to a site. Your site has its own address.
- **Custom domain attach.** The managed custom-domain flow runs on Drupflare's zone, so it isn't available on your account.

## Update and roll back

Updating a site uploads the new release's script and any changed files to the same script in your account. A rollback uploads an earlier release the same way. Both run the health check afterward. If the check fails after an update, Drupflare uploads the previous release again and says so.

Neither one touches the names registry, site authority or any other resource in your account.

## Delete a site

Deleting a self-managed site stops Drupflare from managing it. The site isn't removed from your account, and what it serves keeps serving. Drupflare keeps its record of what it created, so you can purge later.

## Purge a site

Purge is the second step. It needs the site ID typed in as a confirmation, and it waits out the hold that follows a delete. Purge removes only what Drupflare recorded for the site: its script, its route, its namespaces, its buckets and its databases.

Purge leaves a resource alone and names it in the result when it can't be sure the resource is still ours:

- A script that someone changed since Drupflare uploaded it, because its marker is gone.
- A Strata bucket that still holds objects.

Everything else in your account stays as it was, including resources with names that look like ours.

## Revoke the connection

Revoke from the Planes page after you finish. See [connect Cloudflare](./connect-cloudflare.md). The revoke stops and lists any live sites on the account, so purge or hand them over first if you want Drupflare to remove them.
