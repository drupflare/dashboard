---
title: Adopt to managed
description: Move a self-managed site under managed operation without losing its data.
audience: [developer]
type: written
draft: true
---

Adopting a self-managed site makes a managed copy of it on a Drupflare address. The original site is never changed or deleted. The copy is one-way: after it finishes, the two sites are independent and changes to one do not reach the other.

## What it does

Press Adopt on the site page and confirm. You need a signed-in session with a recent step-up, because the copy is a billable site. API keys cannot start an adoption.

The adoption runs as one activity and takes a few minutes:

1. It checks that the site is self-managed, live, reachable, not adopted before, and that Drupflare holds owner access to it.
2. It copies the site database into storage as a backup, page by page, and checks every part against its hash. The backup stays in the site's backup list under the label "Copy made to adopt the site".
3. It creates the managed site on a Drupflare address from the same template.
4. It records the link from the original to the copy.
5. It restores the database copy into the new site and waits until the new site has applied it.
6. It checks that the new site answers, then marks it ready.

The site's admin accounts come from the copied database, so you sign in to the new site with the same credentials as the original.

## When it refuses

The adoption refuses before it creates anything, with a plain reason, in these cases:

- The site is not self-managed, not live, or already adopted.
- Another change to the site is running.
- Your plan has no room for another site. The original and the copy both count.
- Drupflare has no owner access to the site, or the site does not answer.
- The database is larger than one restore into a managed site accepts, 16 MiB by default. The activity shows "Needs a Larger Restore Path". A paged restore for larger databases is an open request to the worker project, so such a site cannot be adopted yet.

## If it fails part way

The activity rolls back. The mark on the original is removed and the half-made copy is cleaned up, which frees its address. The original site is left as it was. The database copy stays as a backup once it was saved. Press Adopt again to start a new attempt.

## What is built and what is not

Built: the checks, the database copy, the managed copy, the restore, the link between the two sites, and the rollback.

Not built:

- Uploaded files outside the database, such as images and documents, are not copied. The database refers to them, so they will be missing on the copy.
- Attaching your own hostname to the copy, and the DNS instructions for it. The copy answers on its Drupflare address only.
- The first-month credit.
- A live run against a real Cloudflare account. The workflow is covered by tests with fakes.
