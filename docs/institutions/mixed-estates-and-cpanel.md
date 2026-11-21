---
title: Mixed estates and cPanel
description: Plan an estate that mixes Drupal sites on Drupflare with sites on shared hosting.
audience: [central-it]
type: written
draft: true
---

A mixed estate has some sites on Drupflare and some on other hosts. Plan them as one list, but move them on separate tracks.

Drupflare connects to a server you give it over SSH (a secure remote login). See [Connect your server](/docs/guides/migration/connect-your-server). The dashboard has no cPanel connector (cPanel is a web hosting control panel). A site on shared hosting that gives you no SSH access cannot be assessed or moved by the dashboard today.

## Plan the split

1. Mark each site as SSH-reachable or not.
2. For SSH-reachable sites, follow the [estate walkthrough](/docs/institutions/estate-walkthrough).
3. For the others, record the host and the owner. Decide with the owner whether the site stays where it is or moves by a method you run yourself.

## Keep both lists current

Shared hosting sites change without the dashboard knowing. Re-check the list before each wave.
