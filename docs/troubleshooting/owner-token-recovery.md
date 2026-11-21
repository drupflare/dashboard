---
title: Owner token recovery
description: What it means when the dashboard cannot read a site's health because the site refused its token, and what to do about it.
audience: [developer, agency, security-reviewer]
type: written
draft: true
---

This page explains the Health Unavailable message and how the owner token is involved. It is for site owners.

The health view shows **Health Unavailable** with this message: "The site did not accept the access the dashboard holds for it, so its health cannot be read."

The dashboard holds an owner token for each site. The token is the secret that lets the dashboard read the site and act on it. When the site refuses the token, the dashboard cannot read the site or change it.

## Check first

- Did someone change the site's token outside the dashboard? A rotation (replacing the token with a new one) that started and did not finish can leave the two sides out of step.
- Did a rotation start recently? Wait a few minutes and read the health again. The dashboard keeps the previous token while a rotation finishes.
- Is the site still active? The dashboard does not read the health of a site that is not active.

## What to do

If the status does not clear, contact [support@drupflare.com](mailto:support@drupflare.com). Include the site name and the request id from the health page.

Do not send the owner token, a password or a copy of a secret in the message. Support does not need them.

## What to avoid

Do not paste the owner token into a ticket, a chat or a repository. If you think the token was exposed, say so in the same message, and support will rotate it.

See [ownership and owner tokens](/docs/concepts/ownership-and-owner-tokens) for how the token is kept.
