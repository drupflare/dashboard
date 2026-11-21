---
title: Health and repairs
description: What the site health statuses mean, where the health tree gets its findings, and how automatic repairs are classed.
audience: [developer, agency, department-owner, central-it]
type: written
draft: true
---

The dashboard reads each site's health on request. The site page shows one of five statuses.

- **Healthy.** The site answers and no finding needs attention.
- **Needs Attention.** The site answers, and something on it needs a look.
- **Starting.** The site is restarting or unpacking its database.
- **Not Responding.** The site did not answer, or it answered with an error.
- **Health Unavailable.** The site answered, but the dashboard could not read the answer. This happens when the token the dashboard holds for the site is refused.

## The health tree

The health tree lists where each finding came from. Three sources feed it:

- **Reconcile.** Checks whether the site's settings match the version the dashboard ships.
- **Supervisor.** Checks the site while it runs.
- **Repair.** Shows what the platform is doing about a problem.

Each node has a level: ok, info, warn, error or critical.

## Repairs

A repair is a named action for a known problem. Each repair has a class that says what it touches.

- **Safe.** The repair does not touch stored data.
- **Rebuild.** The repair rebuilds cached or temporary pieces and keeps stored data.
- **Stateful.** The repair changes stored data, so it runs with extra care.

Each repair also has an automation level: it runs on its own, runs with a guard, waits for approval, or needs a person to act. Some repairs can be undone. A repair that cannot be undone says so.

The [repair ladder](/docs/troubleshooting/repair-ladder-explained) explains what happens when a repair does not clear the problem.
