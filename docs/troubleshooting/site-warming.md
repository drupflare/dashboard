---
title: Site is starting
description: What the Starting status means, how long to expect it, and when to look further.
audience: [solo-beginner, developer, department-owner]
type: written
draft: true
---

This page explains the Starting status and what it means for a site. It is for site owners.

The site page shows **Starting** while the site restarts or unpacks its database. A site can also show this after a restore.

The page names the step in progress. You may see one of these:

- **Unpacking the database, part 2 of 5.** The database is loading in parts. The numbers count the parts.
- **Unpacking the database.** The database is loading.
- **The site is restarting.** The site has reset and is coming back.

## What to do

Wait. The status changes to Healthy or Needs Attention once the site responds. Refresh the page after a few minutes.

If the status stays on Starting, open the site's **Automatic Repairs** page. A repair in progress shows there. If no repair runs and the status does not change, contact support with the request id from the page.

See [health and repairs](/docs/concepts/health-and-repairs) for the other statuses.
