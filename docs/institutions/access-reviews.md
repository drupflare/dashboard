---
title: Access reviews
description: Review who has access to the organization and its sites, record a decision on each item, and remove what is no longer needed.
audience: [security-reviewer, central-it]
type: written
draft: true
---

An access review lists who has access to what, as it stands when the review opens. An owner or admin goes through each item and marks it Keep or Remove. Removals take effect when the review closes.

## What a review covers

A review lists five kinds of item:

- **Member.** A person in the organization.
- **Access Grant.** Access a person has to one site.
- **Agency Access.** A delegation to an agency.
- **API Key.** A key that someone holds.
- **Service Account.** An account for automated work. See [Service accounts](/docs/institutions/service-accounts).

## Running a review

1. Open a review at `/org/reviews`. Owners and admins can open and close reviews.
2. Go through each item and mark it Keep or Remove. The decision is recorded as you make it.
3. Close the review. Closing is refused while any item has no decision. Each Remove is applied when the review closes.
4. Export the evidence. The export is a CSV (a spreadsheet file) with one row for each item and its decision. The JSON form of the same export includes a SHA-256 hash (a fingerprint of the file) of the CSV, so you can show later that the file has not changed.

You cannot decide an item that is your own access. Another owner or admin has to decide it.

## Who can decide

Owners and admins can decide every item. A department admin can decide the items inside their own department and the departments below it: department roles, site access, and service accounts there. They see only those items. Members, agency access and personal API keys belong to the whole organization, so only owners and admins decide them. Opening a review, closing it, carrying out a removal right away and exporting the evidence stay with owners and admins. Owners and admins turn this on or off with the "Department admins can decide review items" setting at `/org/reviews`. It is on by default. Turning it off keeps every decision already made and stops department admins from making new ones.

## Stale access

The stale report lists access that has not been used for 90 days. It also lists access that has never been used.

## Scheduled reviews

A schedule opens a review on its own. The choices are off, quarterly (every 91 days) and yearly (every 365 days). The first scheduled review opens one interval after the schedule is set. An automatic job checks for due reviews every 15 minutes.

## Review mail

Reviewers are not emailed when a review opens yet. The review email waits for the mail preference store (where each person's mail choices are kept), so reviewers need to open the review at `/org/reviews` themselves.
