---
title: Delete and restore a site
description: Delete a site, and restore it within the retention window.
audience: [solo-beginner]
type: written
draft: true
---

## Strata storage

A managed site that uses Strata has a private bucket for its history. Purging the site revokes the bucket's access token and deletes the bucket. If the bucket still holds objects, Cloudflare refuses the delete, so the bucket stays and the purge result names it. The rest of the purge finishes.
