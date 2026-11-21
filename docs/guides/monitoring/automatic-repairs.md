---
title: Automatic repairs
description: The repairs the platform makes on a site without you, how each one is classed, and how to see and undo one afterwards.
audience: [department-owner, developer]
type: written
draft: true
---

This page explains the automatic repairs the platform makes and how to read them. It is for owners whose site needs attention.

The platform checks each site and makes a repair when it finds a known problem. Each repair has a name, such as Blank Page Fixed, PHP Restarted or Site Files Brought Up to Date.

## Where to see them

Open the site's **Automatic Repairs** page. It lists repairs newest first. Each row shows the repair's title, what was found, what was seen before and after the repair, and its status.

- **Running.** The repair is in progress.
- **Fixed.** The repair ran and the check that followed showed the problem gone.
- **Not Fixed.** The check showed the problem still there, or the repair stopped after repeated attempts.
- **Not Run.** The platform refused to run the repair.
- **Undone.** The repair was undone.

## What a repair touches

Each repair has a class that says what it changes.

- **Safe.** It does not change stored data.
- **Rebuild.** It rebuilds cached or temporary pieces and keeps stored data.
- **Stateful.** It changes stored data, so it runs with extra care.

Each repair also has an automation level. Some run on their own. Some run on their own once checks pass. The checks include whether the site is shedding load, whether the site lease is held and whether a database transaction is open. Some wait for approval, and some need a person to act.

## Undo a repair

A fixed repair can be undone, unless it is itself an undo or the repair has no undo. Choose Undo Repair, then Confirm Undo. The undo appears in the same list. A repair that cannot be undone says so, and a repair that was already undone shows that.
