---
title: Data location
description: Where each kind of data is stored and which regions it can reach.
audience: [security-reviewer]
type: written
draft: true
---

Drupflare does not set a data location on any storage product today. No contract term commits to where data is stored. Ask Drupflare before you rely on a location.

## What Cloudflare offers

Cloudflare R2 lets a bucket (a storage container) be set to the `us`, `eu` or `fedramp` jurisdiction (a region setting). Cloudflare's R2 "Data location" page (read on 2026-11-21) says the jurisdiction is set when the bucket is created and cannot be changed afterward. It also says a location hint (a suggested region) is a best effort and not a guarantee. Other storage products have their own data location pages. Read the page for each product before you rely on it.

## What Drupflare uses

The dashboard's own stage configuration sets no jurisdiction on its storage connections (bindings). Since a jurisdiction can only be set at creation, a US or EU setting would need new storage and a data move. Ask for the current state before a review.
