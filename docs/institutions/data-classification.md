---
title: Data classification
description: Label each site as Public, Internal, Restricted or Regulated so that the policy group for that label applies to it.
audience: [security-reviewer, central-it]
type: written
draft: true
---

Each site can carry one of four labels: Public, Internal, Restricted or Regulated. The label does nothing by itself. An organization can attach a policy group to a label, and every site with that label then takes on the group's rules. See [Policy groups](/docs/institutions/policy-groups).

## Setting a label

Owners and admins set a site's label. Anyone who can read the site can read its label.

## Default groups

For each label, the organization can choose one policy group. A new choice replaces the old one. A label with no group adds no rules, so its sites keep the label and nothing else changes.

A site can also have a group of its own, and the groups apply together. The order is in [Policy groups](/docs/institutions/policy-groups#where-a-group-applies).

## What the label does not check

The Data Locations rule is not enforced yet. Drupflare does not track where a site's data lives, so a label cannot stop data from being stored in a region the rule forbids.
