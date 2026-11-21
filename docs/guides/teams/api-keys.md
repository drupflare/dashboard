---
title: API keys
description: Create, scope and revoke API keys for a service or a script.
audience: [developer]
type: written
draft: true
---

This page shows you how to create, scope and revoke an API key. It is for owners and admins who automate work.

An API key lets a script or service call the Drupflare API for your organization. Use keys for automation. People should sign in to the dashboard.

## Create a key

Open the API Keys page at `/org/api-keys`. You need the developer role or higher.

1. Name the key after the service that will use it.
2. Pick an expiry: 30, 90, 180 or 365 days.
3. Pick the actions the key may perform. The list shows only the actions your role holds.
4. Confirm with a step-up check.

The key is shown once. Copy it before you leave the page. Each organization is bounded at 100 active keys.

## What a key can do

A key can perform the actions it was given. A key cannot:

- Create or change other keys.
- Perform actions that only a signed-in session can perform, such as domain changes and billing portal access.
- Perform administrator actions.

## Revoke a key

Choose **Revoke** on the key. The key stops working on its next request. If the key was used recently, the page asks you to confirm first.

To rotate a key, create a new one, move the service to it, then revoke the old one. The page shows each key's last use, which helps you find what still uses it.

## Expiry

A key stops working on its expiry date. Create the replacement before that date.
