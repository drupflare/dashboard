---
title: Install a module
description: Install a module or theme from the dashboard's list onto a Drupal site, then turn it on.
audience: [developer]
type: written
draft: true
---

This page shows you how to install a module or theme on a Drupal site from the dashboard. It is for site owners and developers.

A module or theme from the dashboard's list can be installed on a Drupal site. Installing puts the code on the site. It does not turn the module on. You turn it on as a second step.

## Install

1. Open the site and go to Modules.
2. Choose the module or theme and choose Install.
3. If the module has never run on a site, tick the box that says it has never been run on a site. Then choose Install.

Before anything changes, the dashboard checks the site again and takes a restore point. The install then runs as an operation, and the progress shows each step.

The dashboard refuses three kinds of module: one that ships with every site, one that cannot run on the site, and one that is not on the list.

## Enable

When the install succeeds, choose Enable on the module. The dashboard takes another restore point first and checks the site afterwards. A module is off until you turn it on.

## Undo

Each install and enable takes a restore point, so you can go back to the state before the change. The code history on the site also records code that a dashboard edit delivered. See [roll back code](/docs/guides/code/roll-back-code).
