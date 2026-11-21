---
title: Health tree
description: Read a site's health tree from the top verdict down to the check that needs attention.
audience: [department-owner, developer]
type: written
draft: true
---

This page explains the Site Health section and the checks behind its verdict. It is for owners who read a site's health.

The Site Health section on a site's overview shows a verdict and, under it, the checks the platform ran.

## The verdict

The verdict is one of five words.

- **Healthy.** The site answers and its checks pass.
- **Needs Attention.** The site answers, and at least one check needs a look.
- **Starting.** The site is restarting or unpacking its database.
- **Not Responding.** The site did not answer the dashboard. The dashboard reports it as a state.
- **Health Unavailable.** The dashboard could not read the site's health.

When every check passed on the last read, the section shows Nothing to Fix. The section shows when it last read the site.

## The rows

Each row in the tree has a level, a title and a history.

- The level is **OK**, **Info**, **Warning**, **Error** or **Critical**.
- **What Happens Next** says what the platform is doing about the row, if anything.
- **History** lists the most recent changes to the row.
- **Diagnostics** is collapsed. Open it for the values behind the row.

Start with the rows at Warning, Error or Critical.

## Reading it from code

The site health route is `GET /api/v1/orgs/{orgId}/sites/{id}/health`. It reads the site through its own address, and it keeps each answer for 15 seconds. A site of another organization is not found.
