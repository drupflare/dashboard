---
title: Client workspaces
description: Keep each client's sites, people and billing separate inside one agency account.
audience: [agency]
type: written
draft: true
---

This page shows you how to group one client's sites in an agency account. It is for agencies.

A client workspace groups one client's sites inside your agency account. Create one per client so their sites and usage stay apart.

Client workspaces need the agency entitlement (a feature your plan includes) on your plan. The client list at `/org/clients` is for admins.

## Create a client

Open `/org/clients`, add a client with its name, and save. The client appears with no sites.

## Add sites to a client

Adding a site to a client is not in the dashboard yet. The API has the routes, but no page calls them.

## Usage export

The Clients page can export a CSV of monthly views for each client once you choose a month. The export reads the usage records for the client's sites.

Usage is not collected in production yet. Until it is, months show as not recorded, not as zero. Fields that start with a formula character are escaped with a leading apostrophe, so the file opens safely in a spreadsheet.

## Not available yet

- Monthly client report emails. See [Client reports](/docs/agencies/client-reports).
- Moving a client's site to another organization. See [Transfer a site](/docs/guides/teams/transfer-a-site).
