---
title: Ownership and owner tokens
description: What the owner token does, how the platform keeps it, and what the first admin password is.
audience: [developer, security-reviewer, agency]
type: written
draft: true
---

The owner token is the credential the dashboard uses to act on a site. Drupflare stores it encrypted and reads it only when it acts on the site.

When the dashboard reads a site's health, it replaces the token with a placeholder before it parses the answer, so the token does not appear in the health output.

## Rotation

The owner token can be replaced. While a replacement is in progress, the previous token is kept so that the change can finish. Once the change completes, the previous token is removed. See [owner token recovery](/docs/troubleshooting/owner-token-recovery) if a site stops accepting the token.

## The first admin password

A new site has an admin password for its first sign-in. The password can be revealed once. After it is revealed, it reads as revealed. A password can also read as expired or unknown.

Read [what we store](/docs/security/what-we-store) for the full list of stored secrets.
