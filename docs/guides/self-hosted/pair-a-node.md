---
title: Pair a node
description: Pair a bastion node with the dashboard over the fleet link.
audience: [self-hosting-operator]
type: written
draft: true
---

## Sites Found on Your Box

Once a node is paired, its box reports the sites it runs. The dashboard adds each site it does not know to your organization's list, marked Found on Your Box. The row is named from the site's host. If the box shares only hashed names, the row gets a placeholder such as "Site 1 on your-box", and you can rename it from the site page.

The dashboard never creates, renames or deletes anything on the box. It reads the list and changes its own rows.

If a listed site stops appearing in the box's reports, the row shows Not on the Box. The dashboard keeps the row until you remove it. Removing a site here removes the row only. A site found on your box keeps serving, and the dashboard does not add it back.

## Create a Site on Your Box

The dashboard can add a Drupal site to a paired box. The box needs a tenant first. Run `bastion tenant add <name>` once. The dashboard cannot create a tenant, because a tenant carries limits you set, and a box without one refuses the command with `no_tenant`.

Create a self-hosted Drupal site in the dashboard and name the box and the host. The dashboard sends the box a `site.add` command, and the box holds it until you approve it. `bastion pair status` lists what is waiting. Run `bastion pair approve <id>` to let it through, or `bastion pair reject <id>` to refuse it.

An approved command downloads the site files from the release, checks their checksum and structure, and writes the site's configuration only after both checks pass. Files that fail a check leave the box unchanged, and the operation shows the reason. The download is about 25 MB.

The site answers once the tenant runs the new files. Run `bastion reload` on a box started with `bastion up`, or restart `bastion serve`. The box serves the site's styles, scripts and images itself, from the folder it placed them in, so a visitor sees the finished page with the dashboard switched off.
