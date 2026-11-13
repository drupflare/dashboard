---
title: Restore onto bastion
description: Move a managed site onto a server you run, using a backup of the site.
audience: [self-hosting-operator, central-it]
type: written
draft: true
---

A backup of a managed site restores onto a site that runs on your own server under bastion. Nothing in this path calls Drupflare. Once the restore finishes, the server answers visitors with the dashboard switched off or unreachable.

## What you need

- A backup of the site, downloaded from the dashboard. The download needs a signed-in session. An API key cannot download a backup.
- A server running bastion with a site added from the current box bundle. See [Install bastion](../self-hosted/install-bastion.md).
- The owner token of that new site. You get it when you claim the site in step 2.

## What moves and what does not

The backup carries the database: content, users, configuration and the site settings stored in the database. It does not carry:

- **Secrets.** The owner token, the Cloudflare connection, mail settings, the hash salt and the git provider tokens stay behind. The new site keeps the owner token it was claimed with. One-time login links and form tokens issued by the old site stop working, because the salt differs.
- **Files held only in object storage.** The backup lists file records but not the bytes of files the managed site had moved out of the database. A site with such files needs them copied separately. The site used to test this guide had no uploaded files, so this guide does not show that copy.
- **Your address.** The new site answers on the host you gave it when you added it. Pointing your domain at the server is a separate step.

## Steps

1. **Add and start the site.** Add a site on the box from the current box bundle and wait until its front page answers. A new site spends about one second finishing its first-run setup.

2. **Claim it.** Send a `POST` to `/firstrun` with a site name and an administrator address. The reply holds an `ownerToken` and an `adminPass`, each shown once. Save the token. The administrator password is replaced by the old site's in step 3.

3. **Send the backup.** Send a `POST` to `/restore` with the backup file as the request body and `Authorization: Bearer <owner token>`. A dump up to 16 MiB goes in one request. A larger one goes through `/restore-parts` in parts of at most 1 MiB. The reply says how many chunks and statements the site stored.

4. **Wait for the replay.** Read `/health` with the same token. Its `import` field moves from `pending` to `applied`. The site answers 503 while it replays.

## Check the result

- `/health` reports the import as `applied`.
- Export the new site (`GET /export?cursor=start&body=1`, joining the `sql` of each page). The file should match the backup you restored. In the test it was byte for byte identical: 6,259,446 bytes, 96 tables, 1,281 rows.
- Load the front page, the login page and a page that answers 403 or 404. Compare them with the old site. Expect these differences and no others: the host name, the random view id, and the permissions hash that depends on the salt.
- Open `/user/login`. The page renders and matches the old site's. The user table came with the backup, so the old administrator's password is the one that applies. The test did not sign in.
- Static files (styles, scripts, fonts, the icon) come from the box's own asset folder, which the front door answers before a request reaches the site. Compare their hashes with the old site's. A box on an older bastion build passes these paths to the site, which answers 404 for them.

## What a visitor sees during a restore

The site answers 503 while it replays. When the last chunk applies, the site clears its stored pages, moves its page generation forward and resets its running PHP, so the next request renders from the restored database. On a local box with a site restored from a stage backup, the first request after `applied` showed the restored site name, and six more pages matched. The first request cold-boots PHP and took 2.0 to 2.3 seconds. Other locations can keep answering with pre-restore pages for about 10 seconds after the last chunk. A box that runs an older worker build does not do this reset: there, send a `POST` to `/bump` with the owner token and restart the site before anyone loads a page, or it keeps serving the name and settings it had before the restore.

## Related

- [Restore a backup](../data/restore-a-backup.md)
- [What leaves your box](../self-hosted/what-leaves-your-box.md)
