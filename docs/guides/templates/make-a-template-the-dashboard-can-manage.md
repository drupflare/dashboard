---
title: Make a template the dashboard can manage
description: How a template gets into the dashboard today, for a Drupal template Drupflare builds and for a custom Worker template you upload.
audience: [developer]
type: written
draft: true
---

This page shows you how to offer your own template on the Create a Site page. It is for developers.

The dashboard offers two kinds of template on the Create a Site page. Drupflare builds the Drupal templates. You bring your own template as a Worker bundle.

## Drupal templates

Drupflare builds each Drupal template from its corpus and lists it with its build state. The list shows any security advisories in the template's Drupal core, any patch that did not apply, and whether the template fits the Free plan. A template that is not built yet shows why. You cannot add one from the dashboard.

## Custom Worker templates

For your own code, build a Worker and upload it as a `.tar.gz`. The dashboard reads the archive, lists what it found, and creates a site that serves it. The file rules, the supported bindings and the plan requirement are on [create a custom Worker site](/docs/guides/sites/create-a-custom-worker-site).

Each uploaded bundle has a `bundleId`. You can create more than one site from the same bundle. A site moves to a newer bundle through its bundle route, and the update keeps the stores the site already uses. An update that changes a store or drops a migration step is refused.

The bundle belongs to the organization that uploaded it. Another organization cannot use it.

## Not available yet

A shared gallery where outside developers list their own templates is not available yet. The template list comes from a fixed set in the dashboard, and the entries marked Coming Soon cannot be used.
