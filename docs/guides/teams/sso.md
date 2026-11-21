---
title: Single sign-on
description: Sign in to Drupflare through your organization's identity provider.
audience: [central-it, security-reviewer]
type: written
draft: true
---

This page shows you how to set up organization sign-in with your identity provider. It is for organization owners and IT staff.

Organization sign-in lets people sign in to Drupflare through your identity provider. Only OpenID Connect (a standard sign-in protocol) works today. SAML is not available yet.

Organization sign-in needs a plan that includes it. Without that plan, the Organization Sign-In page at `/org/sso` does not offer the form.

## What you need

- An OpenID Connect provider, with a client ID and a client secret.
- The issuer URL. It must use https. Drupflare reads the provider's discovery document (a file at a fixed address that lists its sign-in settings) from it.
- An email domain you control, and access to its DNS. Only addresses in that domain can sign in through the organization.

## Set it up

Only an owner can change these settings.

1. Open `/org/sso`. Enter the issuer, client ID and client secret.
2. Map groups to roles, if your provider sends groups in the ID token. A person gets the highest role their groups map to. The owner role cannot come from a group.
3. Add a TXT record for each domain. The name is `_drupflare-sso.` followed by the domain, and the value is `drupflare-sso=` followed by your organization ID. This shows that you control the domain. If you run the test first, it prints the exact name and value for each domain.
4. Run the test. Drupflare checks the discovery document, the signing keys and the DNS record of every domain. If a record is missing, the test names it.
5. Turn sign-in on. Drupflare refuses to turn it on until the saved settings pass the test. Changing the issuer, client ID or secret clears the passing test, and so does adding a domain.

Register this redirect URI with your provider: `/api/v1/auth/sso/<organization slug>/callback`, on the Drupflare origin.

## What happens at sign-in

- A person with no Drupflare account gets one on their first sign-in through the provider.
- A person whose email matches an existing account must confirm the link. They sign in to the existing account, then confirm. The accounts are not merged without that step.
- On each sign-in, a member who is not an owner gets the role their groups map to. That can lower a role. A group removal at the provider takes effect at the next sign-in.
- A sign-in through the organization lasts up to 8 hours.

If sign-in fails, the person lands on the sign-in page with a short code, such as `failed`, `domain` or `unverified`. The provider's error text is not shown.

## Provider notes

- Drupflare reads the email and the groups from the ID token. It does not call the user info endpoint. If your provider leaves groups out of the ID token, turn on the groups claim there.
