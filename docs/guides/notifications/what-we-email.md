---
title: What we email
description: Every kind of email Drupflare sends and why it sends it.
audience: [solo-beginner, nonprofit]
type: written
draft: true
---

This page lists the email Drupflare sends and how each category works. It is for every account holder.

Drupflare sends transactional email only. Each message belongs to one category. Essential mail always sends and carries no unsubscribe link. Optional mail sends only to people who opted in, and each optional message has an unsubscribe link for its own category.

| Message                                                            | Category           | Essential or optional |
| ------------------------------------------------------------------ | ------------------ | --------------------- |
| Sign-in code, recovery code or email verification code             | `login-code`       | Essential             |
| Invitation to an organization                                      | `invitation`       | Essential             |
| Security event, such as a new sign-in method                       | `security-event`   | Essential             |
| Failed payment                                                     | `payment-failure`  | Essential             |
| Spend budget at 90 percent, or a hard budget that stopped a site   | `budget-limit`     | Essential             |
| Price, terms or other consequential contract change                | `mandatory-notice` | Essential             |
| Observability finding, incident, upgrade, restore or repair result | `ops`              | Optional              |
| Invoice copy or usage warning                                      | `billing-info`     | Optional              |
| Included views reached 75, 90, 100 or 250 percent                  | `billing-info`     | Optional              |
| Client or site report                                              | `reports`          | Optional              |
| Spaced rollup of optional items                                    | `digest`           | Optional              |

Drupflare sends no feature announcements, promotions or referrals by email.

The 90 percent budget notice and the stop notice go to owners, billing members and the verified billing contact. The stop notice is not sent while a budget runs in testing mode. See [spend budgets](/docs/guides/billing/budgets).
