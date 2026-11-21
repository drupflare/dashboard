---
title: Site needs attention
description: What the Needs Attention status means, how to read the finding behind it, and what the dashboard does about it.
audience: [solo-beginner, developer, department-owner, agency]
type: written
draft: true
---

This page helps you read a Needs Attention status and check the repairs behind it. It is for site owners.

A site shows **Needs Attention** when it responds, but something on it needs a look.

## Read the finding

Open the site's health view. Each finding has a title, a level and a short description. The level runs from info to critical.

A finding often comes with one of these words:

- **Automatic repair.** The dashboard has a repair for this problem. It runs the repair itself when the repair's conditions hold.
- **Needs a person.** No automatic repair runs. Read the description and follow it.

## Check the repairs

Open the site's **Automatic Repairs** page. It lists each repair the platform has run for this site, with its time and result. A repair that cleared the finding reads as done.

Some repairs can be undone from the same page. A repair that cannot be undone says so.

## When it does not clear

If the status stays on Needs Attention after a repair, the problem is not fixed yet. Look at the finding again. If it names something you changed, check that change first. If the cause is unclear, contact support with the request id (the reference number for the failed request) and the finding's title.

See [health and repairs](/docs/concepts/health-and-repairs) and [repair ladder explained](/docs/troubleshooting/repair-ladder-explained).
