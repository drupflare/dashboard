---
title: Export your site
description: Download a site's database as an SQL file, and what that file does and does not hold.
audience: [solo-beginner, self-hosting-operator]
type: written
draft: true
---

This page shows you how to download a site's database as an SQL file. It is for site owners and anyone who keeps their own copy.

The dashboard can download a backup of a site's database as one SQL file. The file holds no secrets.

## Download a backup

1. Open the site and go to Restore Points.
2. Choose Back Up Now. A backup appears in the list once it finishes.
3. Choose Download on that backup.

Download needs a fresh sign-in (the dashboard asks you to confirm your sign-in). If the dashboard asks for one, confirm it on the Account page, then try again. A download is recorded in the audit log (the record of who did what) before it starts.

The file holds the database only. Uploaded files, the owner token and git access tokens are not in it. Keep those separately if you need them.

## Not available yet

A single export of a whole site, with its code and its files in one archive, is not available yet.
