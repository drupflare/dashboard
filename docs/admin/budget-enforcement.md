---
title: Budget enforcement
description: Admin runbook for spend budget stops, the settings they need, the shadow mode they start in and what to check before a stop is switched on.
audience: [developer]
type: written
draft: true
---

Spend budgets are described for owners in [Spend budgets](/docs/guides/billing/budgets). This runbook covers how the platform runs them.

## How a budget is checked

Every minute, the `budget-evaluate` task compares each organization and each site with its budget. It reads the month-to-date views that the engine has acknowledged. That count is a lower bound (the real count is at least this high), so a stop is never early because of the count alone. When a budget reaches its cap, a hard budget changes the site's state. Dispatch (the part that routes visitor requests to each site) then answers visitors with a 503 response. The response body says "This site is temporarily unavailable." and sends `Retry-After: 60`. It does not name the plan, billing or budget.

A stop takes effect within one lease interval plus one counting flush interval. The lease interval is how long a lease lasts (see [Revocation and leases](/docs/admin/revocation-and-leases)). The flush interval is how often counts are saved. Counts not yet saved can be lost when a server restarts, and that adds to the delay. The default lease is 30 seconds. The strict lease is 5 seconds. The unsaved count is not yet measured on a live Worker (a deployed script), so treat the bound as an estimate until that run is done.

A suspended site stays suspended. A budget change never replaces a suspension. See [Abuse queue](/docs/admin/abuse-queue).

If the count for a site cannot be read, an existing stop stays in place. A missing count does not lift a stop.

## Modes

The variable `BUDGET_ENFORCEMENT` sets the mode. Only the value `on` writes stops. Any other value, or no value, runs in shadow mode. Shadow mode runs the checks and logs what it would do, but it stops no site. A misspelled value therefore never stops a site.

In shadow mode the task:

- works out which sites would be stopped and logs "budget enforcement would block",
- writes `budget.would-block` and `budget.would-unblock` audit rows,
- sends the budget alerts,
- writes no stop to any site.

Owners see "Would stop (testing mode)" on the budget screen for a site in this state.

## Settings the task needs

The task skips its run, and logs a reason, when a setting is missing:

- The engine binding (the connection to the engine) and a counts secret, a secret value kept in the platform's secret store. The counts secret is `COUNTS_SECRET`. When it is unset, the engine uses `START_SECRET`.
- For `on` only, a budget secret named `BUDGET_SECRET`. Without it, `on` runs as shadow.

Set secrets with the platform's secret store. Never write their values into a docs page, a ticket or a commit.

Optional alert mail also needs an unsubscribe link. The signing key for the link is derived from the existing `AUTH_CODE_SECRET`, so no new secret exists. Where that secret is unset, optional budget alerts are held, and the task logs "held: no unsubscribe secret" once for each held alert in each run. A held alert is not recorded as sent, so it goes out in the first run after the secret exists, still once for each period. Essential alerts always go out: the stop notice, and the notice at 90 percent of the budget.

## Mail

- The stop notice and the 90 percent notice are essential mail. They go to owners, members with the billing role, and the billing contact once its address is verified.
- The included-views alerts at 75, 90, 100 and 250 percent are optional. They go only to people who turned on billing information mail in their notification settings, and to a billing contact whose notify switch is on. They are held where the unsubscribe secret is unset.
- Pause Optional Mail on the Flags page stops the optional budget alerts. See [Platform switches](/docs/admin/platform-switches).

## Turning on stops

1. Leave `BUDGET_ENFORCEMENT` unset or set to `shadow`. Shadow mode runs the same checks and writes nothing to a site.
2. Read the `budget.would-block` audit rows and the "would block" log lines for a period. Check each one against the owner's view of the budget.
3. Set `BUDGET_ENFORCEMENT` to `on` and set `BUDGET_SECRET` only after step 2 has been reviewed.

A budget change takes effect at once when the change is saved, because the platform checks the budget straight after the save. If that check fails, the scheduled run reaches the same state within a minute. A raised cap lifts a stop on the next lease renewal (the point when the site's lease is renewed).

## Budget changes

- Lowering a budget can stop a site on the next run.
- Raising a budget needs a fresh sign-in by an owner or admin. An API key cannot raise one. Every change is audited with the old and new values.
- Free organizations have no spend budget.
