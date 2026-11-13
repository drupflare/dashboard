---
title: Cutover and rollback
description: Switch traffic to the migrated site and return to the source if it fails.
audience: [central-it, developer]
type: written
draft: true
---

A cutover points your address at the migrated site. Drupflare never deletes the old site, at any step and after any choice. If something goes wrong, the old site is still there with its data.

## Status

The plan, the rules, the approval and the timeline are built and tested. The connections to the old site and to the DNS provider are not. Until they exist, starting a move answers "not available yet", and the page shows the plan without a start button that works. Everything below describes what the move does once those connections are in place.

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
- **Export the new changes.** Save what the new site accepted, then point the address back. You apply the saved changes to the old site yourself. Some kinds of change cannot be carried over, and the page lists them.

If you make no choice within 7 days, the activity is marked failed. The new site keeps serving and the old site is untouched.

## When a check fails

If a check at 5 minutes, 30 minutes, 6 hours or 24 hours finds the new site unhealthy, Drupflare counts the writes it has accepted. With none, it reverses the DNS change. With some, it asks you to choose. If it cannot read the new site at all, it does not reverse anything on its own, because it cannot tell whether the site took writes. It tries again at the next point, and the activity is marked failed if the last point cannot be read either.

## What is not built

- The connection that reads and freezes the old site, and the connection that writes to the new site. Both are defined as ports with in-memory test versions, and the real ones are open work.
- The DNS provider connection that lowers the cache time and points the address.
- The switch that lets the start request through. It stays off until the two connections above exist.
- Applying exported changes back to the old site. You do that yourself.
