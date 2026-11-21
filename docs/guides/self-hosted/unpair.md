---
title: Unpair a node
description: Revoke a paired node in the dashboard so it no longer accepts calls from the dashboard.
audience: [self-hosting-operator]
type: written
draft: true
---

This page shows you how to unpair a node. It is for owners who run a node.

Unpairing a node in the dashboard means revoking it. Revoking cuts the link. The dashboard refuses everything the node sends and sends it nothing. The box keeps running.

Revoking a node that is already revoked changes nothing.

The dashboard side is the revoke action on the node. Removing the link from the box is not covered here.

To pair the box again, start a new pairing. The dashboard issues a pairing that lasts 15 minutes. See [pair a node](/docs/guides/self-hosted/pair-a-node).
