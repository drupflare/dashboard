---
title: Policy groups
description: Apply one set of rules to the whole organization, a department, a single site or a data classification.
audience: [central-it]
type: written
draft: true
---

A policy group is a named set of rules. You assign it to the organization, a department, one site, or a data classification label. The rules only limit what people can do on the sites they reach. A group cannot give anyone more access than their role already gives them.

Owners and admins create groups and assign them. Everyone in the organization except billing members can read the groups.

## Where a group applies

Each assignment has one of four kinds:

- **Organization.** Applies to every site in the organization.
- **Department.** Applies to the sites in that department. A site also picks up the groups of every department above it.
- **Site.** Applies to one site.
- **Classification.** Applies to every site with that label. See [Data classification](/docs/institutions/data-classification).

When more than one group applies to a site, all of them apply. The order runs from the organization, down the department chain, to the site, and then to the label. Where two groups set the same limit, the stricter value wins. A refusal names the group that set it. On a tie, the group nearer the site wins.

## Rules

The table lists each rule and whether the dashboard checks it today.

| Rule                            | What it does                                                               | Status                                       |
| ------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| Blocked Actions                 | Nobody can do the listed actions, whatever role they hold.                 | Enforced                                     |
| Fresh Sign-In Required          | The listed actions need a fresh sign-in first.                             | Enforced                                     |
| Organization Sign-In for Admins | Administrators must sign in through organization single sign-on.           | Not enforced yet                             |
| Permitted Access Types          | A site can use only the listed ways of letting visitors in.                | Enforced when the rule is added              |
| Email Invite Domains            | Email invites go only to addresses at the listed domains.                  | Enforced when the rule is added              |
| Minimum Backup Retention        | Backups are kept at least this many days.                                  | Not enforced yet                             |
| Maintenance Windows             | Upgrades and promotions start only inside the listed weekly windows (UTC). | Enforced                                     |
| Upgrade Rings                   | Upgrades reach the site only in the listed rings.                          | Enforced only when an upgrade records a ring |
| Data Locations                  | Site data stays in the listed regions.                                     | Not enforced yet                             |
| Module Lists                    | Only the allowed modules install, and denied modules never do.             | Enforced                                     |
| Outbound Allow-List             | A site can call only the listed hosts.                                     | Not enforced yet                             |
| Preview Lifetime Cap            | A preview site cannot last longer than the listed number of hours.         | Enforced                                     |
| Forbidden Templates             | A site cannot be created from the listed templates.                        | Enforced                                     |

A rule marked "Not enforced yet" is saved and shown, and nothing is blocked on it. The rule row says why. Four rules are in that state: organization sign-in for admins, minimum backup retention, data locations and the outbound allow-list.

Some checks run at a narrower point than the rule name suggests:

- A preview created with the default lifetime is refused when a group caps the lifetime lower. The person picks a shorter lifetime. The dashboard does not shorten it for them.
- Forbidden templates are checked when a site is created, against the groups assigned to the organization only. A group assigned only to a department does not stop a create.
- Access types and invite domains are checked when a rule is added. A group assigned later does not re-check rules that already exist.

## What a blocked person sees

The API answers a blocked request with the message "A policy group blocks this action." Its details name the group and the rule that refused the request. The dashboard does not show those details yet.

## Changing a group

Delete is refused while a group is assigned. Remove each assignment first, then delete the group.
