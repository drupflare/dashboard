---
title: Cutover and rollback
description: Switch traffic to the migrated site and return to the source if it fails.
audience: [central-it, developer]
type: written
draft: true
---

A cutover points your address at the migrated site. Drupflare never deletes the old site, at any step and after any choice. If something goes wrong, the old site is still there with its data.

## Status

The plan, the rules, the approval, the timeline, the connection to your old server and the connection to the new site are built and tested. Your address lives in your own DNS, so you change it by hand and Drupflare waits to see it move. The new site must run a worker release that can count the changes it accepts. A site on an older release fails the check before approval, and the page says the site needs an update.

## Choose what happens to the old site

You pick one write policy before the move starts. Each one trades a longer window against lost changes.

- **Freeze.** The old site stops taking changes. Visitors can read it, but nobody can log in, post or submit a form until the new site is live.
- **Read only.** Visitors can read the old site, and editors cannot save. Form submissions are refused.
- **Copy the changes.** The old site keeps taking changes while the new site is built. Just before the switch, Drupflare copies what changed since the snapshot. If the same record changed on both sides, the move stops and nothing is switched.

The page shows the expected window for the policy you pick. Freeze and read only count the time it takes the DNS cache to expire. Copy the changes does not, so its window is shorter.

## The steps

The move runs as one activity, in this order:

1. Lock the new site against other changes.
2. Shorten the DNS cache time so the switch spreads quickly.
3. Take a consistent snapshot of the old site.
4. Copy the changes made since the snapshot.
5. Check the new site against the snapshot and the changes.
6. Wait for your approval.
7. Apply the write policy to the old site.
8. Copy the last changes and check them.
9. Promote the new site.
10. Point your address at the new site.
11. Check the new site after 5 minutes, 30 minutes, 6 hours and 24 hours.

Every step can be replayed. If the move is interrupted between the snapshot and the promotion, it resumes where it stopped and repeats no change.

## Approval

The move stops at step 6 and waits. Approval needs a signed-in session with a recent step-up. API keys cannot approve. Only organization owners and admins, and site admins, can start, approve or choose. If nobody approves within 24 hours, the move ends without switching anything and the old site is untouched.

## When going back is still a reversal

Until the new site accepts its first write, going back is a DNS change and nothing is lost. Press Go Back Now and Drupflare points the address at the old site again.

After the first write, going back is no longer a reversal. Pointing the address back would hide what visitors and editors already saved on the new site. Drupflare refuses the DNS reversal at that point and offers three choices:

- **Keep the new site.** Stay on the new site with everything it has accepted.
- **Abandon the new data.** Point the address at the old site and drop what the new site accepted. Those changes are lost.
- **Export the new changes.** Save what the new site accepted, then point the address back. You apply the saved file to the old site yourself.

If you make no choice within 7 days, the activity is marked failed. The new site keeps serving and the old site is untouched.

### What the count means

The new site starts counting when it is promoted, before your address moves. A change is a row that the site's database saved, changed or removed for your content, users or settings. One post usually changes several rows. Caches, sessions, locks, logs and the search index do not count, because they rebuild themselves. A table the site does not recognize does count, so the count errs toward closing the reversal.

The page shows the count from the last check, at 5 minutes, 30 minutes, 6 hours and 24 hours. Pressing Go Back Now reads the count again first. If a write arrived since the last check, Drupflare refuses the reversal and shows the choices.

A signed-in visit counts as a change. Drupal records the time an account was last seen, and that row is a write. If someone on your staff logs in to look at the new site, going back stops being a reversal. Check the new site while signed out, or through the preview, before you approve. The page says this before you approve.

A failed read never counts as zero. If the new site cannot answer, or has lost its count, Drupflare treats the check as unreadable and reverses nothing. The site keeps its count while the move runs and Drupflare ends it when the move finishes, whichever way it ends.

### What the export carries

The file is plain SQL for a MySQL or MariaDB database. It holds one `REPLACE INTO` for each row the new site added or changed, one `DELETE FROM` for each row it removed, and a last statement that re-seeds the id counter. Run it against your old site's database with the `mysql` client, after you take a backup of that database. A `REPLACE` writes the whole row, so it overwrites a row that changed on the old site too.

The file does not carry:

- sign-in sessions, so everyone logs in again
- settings and state that Drupal keeps in key-value storage
- the contents of uploaded files. The records of new, replaced or removed files are in the file, and the bytes are not. Copy the files folder yourself
- changes to the structure of the database, such as a module that added a table
- changes in a table that has no key to identify a row
- changes that reach the new site after the second read, described below

The file is read twice. The first read happens when you choose the export, and the address moves back right after it. Visitors who still hold the new address in a cache can keep writing for as long as the address's cache time, so Drupflare waits that long after the address is back and reads the new site a second time, from where the first read stopped. The second read goes into the same file, which you download once. The page then says "Final changes ready" and how many changes it added, or "No changes after the first file". If the second read fails, the page says so, and the file holds what the first read saw. Download the file after the page shows one of these three, not before.

If the new site stopped recording changes before the move ended, the page says some changes could not be recorded and the file is not a full account. The count in that case is still a valid count for the question of whether going back is a reversal.

`drangler migrate` does not read this file. Its path back to a VPS starts from a full `/export` dump of the new site, converted from SQLite with `drangler migrate convert`. Use the file for the small case, where you want only what changed. Use the full dump when you want to leave the new site entirely.

A database that is not MySQL or MariaDB cannot take the file, because `REPLACE` does not run on PostgreSQL. Drupflare refuses the export for such a source and says so. A PostgreSQL site imports, but the cutover reads MySQL dumps only, so a cutover from one stops with that message.

## When a check fails

If a check at 5 minutes, 30 minutes, 6 hours or 24 hours finds the new site unhealthy, Drupflare counts the writes it has accepted. With none, it reverses the DNS change. With some, it asks you to choose. If it cannot read the new site at all, it does not reverse anything on its own, because it cannot tell whether the site took writes. It tries again at the next point, and the activity is marked failed if the last point cannot be read either.

## What is not built

- The DNS provider connection that lowers the cache time and points the address. You do both by hand, and Drupflare reads the cache time and waits to see the address move.
- Files. The snapshot carries the database only.
- Applying exported changes back to the old site. You do that yourself.
