---
title: Spend budgets
description: Cap the views a site or organization can count in a period, choose whether a limit stops the site or only alerts, and read the alerts.
audience: [department-owner]
type: written
draft: true
---

This page explains how a spend budget stops a site or sends alerts. It is for owners and billing members who set a limit.

A spend budget caps how many views (the visits counted toward your plan) an organization or a site can count in a billing period. You set the cap as a percent of the views the plan includes. Past the cap, a hard budget stops the site. A soft budget sends alerts and stops nothing.

## What a budget is

Each organization can have one budget. Each site can have one too. A site budget never goes above its organization's budget. If you lower the organization budget below a site's budget, the site uses the lower figure while the stored site setting stays as it was.

A budget counts views only. Other usage is not capped by a budget yet.

## Percent of included views

The budget is a percent of the included views for the period. At 200 percent, a site can count twice its included views before the budget is reached. Lower percentages leave less room. The budget screen shows the status, the views counted and which alerts have gone out.

The lowest and highest percent you can set, and the default, are not final. They appear on the budget screen as the server reports them, and this page will not quote a figure until the pricing is reviewed.

## Hard and soft limits

Each budget has one enforcement setting.

- **Stop the site at the limit** (hard). The site stops serving visitors when the budget is reached. This is the default for pay-as-you-go plans.
- **Send alerts only** (soft). Alerts go out at each threshold, and nothing is blocked.

Organizations and sites choose their own setting. A hard site budget under a soft organization budget still stops that site. A hard organization budget stops every site it owns, whatever the site settings say.

Free organizations have no spend budget and stay within the free-tier limits.

## What visitors see

A stopped site answers visitors with a 503 response and this page:

> This site is temporarily unavailable.

The page does not name the plan, the billing or the budget. It sends a `Retry-After` header (a note that tells the caller how long to wait) of 60 seconds. Every visit gets the same page until the stop lifts.

## How far a stop can overshoot

A stop takes effect within one lease interval plus one counting flush interval, plus any unflushed tail the counting mechanism can lose when a server restarts. The default lease is 30 seconds. Views counted in that window can go past the cap. Read the cap as a bound on counted views, not as an exact limit.

## Raising and lowering a budget

Raising the percent, or moving a hard budget to soft, needs a fresh sign-in. Lowering the percent, or moving a soft budget to hard, needs the billing permission. An API key can lower a budget but cannot raise one.

A raised cap lifts a stop when the site next renews its lease.

## Alerts

Alerts go out when the views counted reach these levels:

- 75, 90, 100 and 250 percent of the included views.
- 90 percent of the budget, when no listed level already sits there.
- A notice when a hard budget starts to stop a site.

The notice at 90 percent of the budget and the stop notice are essential mail. They go to owners, billing members and the verified billing contact, and you cannot opt out of them. A soft budget never sends the stop notice. Its 90 percent notice says that nothing is blocked.

The included-views levels are optional billing mail. They go only to people who turned on billing information mail in their notification settings. See [what we email](/docs/guides/notifications/what-we-email).

## Testing mode

A budget can run in testing mode. In that mode a hard budget does not stop anything. It records when it would have stopped and blocks no request, and the stop notice is not sent. The budget screen shows "Would stop (testing mode)" for the site.

## Dollar figures

The screen can show a dollar figure beside a budget. The figure uses the overage rate, and that rate is not yet reviewed. Until it is, the screen says "Not billed yet." instead of a number. Overage billing itself is described in [overage](/docs/guides/billing/overage).
