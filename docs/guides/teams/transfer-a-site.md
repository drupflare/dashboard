---
title: Transfer a site
description: Move a site to another organization and what moves with it.
audience: [agency]
type: written
draft: true
---

This page shows you how to offer a site to another organization and what happens next. It is for agencies and site admins.

A transfer offers a site to another organization. The receiving owner accepts or declines it. Accepting does not move the site yet. The move itself is not available yet.

## Steps that work today

1. A site admin proposes the transfer. Proposing is not in the dashboard yet. The site page has no propose button, so this step needs the API (the programming interface for scripts and tools).
2. The receiving owner sees the proposal on the Transfers page at `/org/transfers` and accepts or declines it. Accepting needs a step-up check (a fresh confirmation of your sign-in).
3. The proposing side can cancel while the proposal is open. A proposal that is not answered within 14 days expires.

A declined or cancelled proposal ends. An accepted transfer does not expire.

## What is not available yet

After acceptance, the transfer waits for the move. The completion step returns "not built" until the move is available. The site stays with the sending organization in the meantime.

The planned move changes ownership, billing and access records. The site's Worker, hostname and data stay where they are. This is the design. The move is not built.

## Before you propose

- Check the receiving plan's site limit yourself. The dashboard does not yet block an accept for a full plan.
- Tell the client that billing and access will change when the move ships.
