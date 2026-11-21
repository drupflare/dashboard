---
title: Run without the dashboard
description: What a self-hosted box does after its link to the dashboard is cut.
audience: [self-hosting-operator]
type: written
draft: true
---

This page explains what a node does after you revoke it in the dashboard. It is for owners who run a node.

Revoking a node cuts its link to the dashboard. The dashboard then refuses everything the node sends and sends it nothing. The box keeps running on its own.

Revoking is the only case covered here. What a box does while the dashboard is unreachable but the link is still up is not documented yet.

To connect the box again, pair it with a new pairing. See [unpair a node](/docs/guides/self-hosted/unpair) and [pair a node](/docs/guides/self-hosted/pair-a-node).
