---
title: Notifications and mail
description: Which messages Drupflare sends by email, the category each one uses, and whether a preference can turn it off.
audience: [developer, security-reviewer]
type: written
draft: true
---

Drupflare sends transactional email only. Every message names one category. Essential categories always send. Optional categories send only to users who opted in.

There is no category for promotions, announcements or referrals, so the code cannot send one. Feature announcements appear in the changelog banner and page.

This page needs review before launch. Counsel must confirm the mandatory-notice rows.

## Classification

| Message                                                                          | Category           | Mandatory notice | Why                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in code                                                                     | `login-code`       | No               | Needed to sign in. Preferences do not apply.                                                                                                           |
| Recovery code                                                                    | `login-code`       | No               | Account recovery never depends on an optional preference.                                                                                              |
| Email verification code                                                          | `login-code`       | No               | Needed to confirm an address.                                                                                                                          |
| Invitation to an organisation                                                    | `invitation`       | No               | The invitee needs it to join.                                                                                                                          |
| Security event, such as a new sign-in method                                     | `security-event`   | No               | Credential and security events always reach the account holder.                                                                                        |
| Failed payment                                                                   | `payment-failure`  | No               | Needed to keep the account in good standing.                                                                                                           |
| Price change, terms change or other consequential contract change                | `mandatory-notice` | Yes              | The change must reach the customer through the notice process the agreement requires. Sent to billing and legal contacts, with in-app display as well. |
| Observability finding, incident open or close, upgrade, restore or repair result | `ops`              | No               | Optional. Sent only to opted-in users.                                                                                                                 |
| Invoice copy or usage warning                                                    | `billing-info`     | No               | Optional. Sent only to opted-in users.                                                                                                                 |
| Client or site report                                                            | `reports`          | No               | Optional. No template exists yet, so nothing sends under this category.                                                                                |
| Spaced rollup of optional items                                                  | `digest`           | No               | Optional. Replaces real-time optional mail for users who opt in.                                                                                       |
| Feature announcement                                                             | none               | No               | Shown in the changelog banner and page. Never mailed.                                                                                                  |
| Promotion or referral                                                            | none               | No               | No category exists. Never mailed.                                                                                                                      |

## Uncertain messages

A message whose classification is unclear takes the stricter route. It goes to the billing or legal contact by email, appears in the app, and carries no promotional wording.

## Unsubscribe

Each optional message carries a signed unsubscribe link for its own category. The link token expires after 365 days. Essential messages carry no unsubscribe link and no list headers.
