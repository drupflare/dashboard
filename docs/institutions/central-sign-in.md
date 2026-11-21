---
title: Central sign-in
description: Require your institution's central sign-in for every person who uses Drupflare.
audience: [central-it]
type: written
draft: true
---

Organization sign-in lets your organization's people sign in through your identity provider (the service that holds your staff sign-in accounts). It works with OpenID Connect, a standard sign-in protocol. SAML is not available yet.

When sign-in is on, a person whose email matches your verified domain signs in through the provider.

The setup steps are in [Single sign-on](/docs/guides/teams/sso). In short:

1. An owner enters the provider's issuer, client ID and client secret.
2. Drupflare tests the settings against the provider.
3. The owner turns sign-in on.

Known limits:

- Sign-in is for the organization's people. It does not replace sign-in for site visitors.
- Non-owner roles follow the provider's groups at each sign-in, if you map them.
- An existing account keeps its current sign-in until its owner confirms the link through the provider. Turning sign-in on does not force every account through it. Ask Drupflare whether a hard requirement is available for your organization.
