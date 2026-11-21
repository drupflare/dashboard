---
title: Read the dossier
description: What the dossier says about a source Drupal site, and what to do with each verdict and finding.
audience: [central-it, developer]
type: written
draft: true
---

This page explains the dossier the import wizard shows for a source site. It is for owners reviewing an import.

When the check finishes, the import wizard shows a dossier for the source site. It has a verdict, a list of things to change and a list of findings.

## The verdict

- **Ready to Import.** The site can be imported as it is.
- **Needs an Upgrade.** The site runs a Drupal version that Drupflare cannot import yet. Upgrade it first, then check again.
- **Cannot Be Imported Yet.** The site uses something Drupflare does not support. The refusals say what.

## What to Change

This section appears only when there is a refusal. Each item is one thing to change on the source site, in plain words.

## Findings

Each finding names something the check saw on the site, such as a module that the database copy does not carry. When the check found nothing to report, the section says so.

## Estates

For more than one site, the assessments API lists each assessment and downloads it as CSV. `GET /api/v1/orgs/{orgId}/assessments/{id}/export` returns the CSV. The assessment's rows are at `GET /api/v1/orgs/{orgId}/assessments/{id}/rows`.
