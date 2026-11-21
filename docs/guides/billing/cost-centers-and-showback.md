---
title: Cost centers and showback
description: Assign site costs to internal cost centers and report them back to each department.
audience: [central-it, department-owner]
type: written
draft: true
---

This page shows you how to group site costs into cost centers and read the showback report. It is for owners and finance staff.

A cost center is an internal account that you charge site costs to. Showback reports each cost center's share of the organization's spend, without sending invoices.

Owners, admins and the billing role can use the Cost Centers page at `/org/cost-centers`.

## Set up

1. Add a cost center with a name.
2. On each site, set its cost center and its technical and business owners. The owner fields are free text.

A site belongs to one cost center. Sites with none appear as unassigned.

## Monthly report

For each cost center, the report shows:

- Its sites and their views for the month.
- The accounting state of each hour: exact, estimated or unaccounted.
- Its share of an amount you enter for the organization, in whole cents. The split is by share of views and adds up to the amount exactly.
- A straight-line projection for the month, labelled as a straight-line projection.

Drupflare does not store the amount you enter and does not show a price for Drupflare. The Drupflare cost is shown as not measured.

An hour with no record counts as zero views and shows as unaccounted. The projection is blank while any hour is unaccounted.

## Export

The report exports as CSV. Formula characters are escaped.

## Current limits

Usage is not collected in production yet, so every site shows as not recorded and every projection is blank until it is.
