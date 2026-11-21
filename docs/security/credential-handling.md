---
title: Credential handling
description: How credentials are stored, used and rotated, and what a site never holds.
audience: [security-reviewer, developer]
type: written
draft: true
---

## People

- Sign-in uses a session cookie (a small piece of data the browser keeps to remember your sign-in). The cookie is tied to this site's exact host name and is marked Secure, so browsers send it only over HTTPS.
- A session ends after 14 days without use, or 30 days after it started.
- Organization sign-in sessions end after up to 8 hours.
- Sensitive actions ask for a step-up check (a request to confirm again).

## Keys and links

- API keys are shown once when created. Each key has an expiry and a fixed set of actions. Revoke a key to stop it before its expiry.
- Invitation and contact verification links carry a random token. Drupflare stores a hash (a one-way fingerprint) of the token, not the token. A link works once.

## Sites

How a site's own credentials are stored is not documented yet. Ask for it before a review.
