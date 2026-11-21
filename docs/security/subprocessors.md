---
title: Subprocessors
description: The third-party services that process customer data for Drupflare.
audience: [security-reviewer]
type: written
draft: true
---

Subprocessors are third parties that process customer data for Drupflare. These are:

- **Cloudflare.** Hosts the dashboard, the sites' Workers and their storage, and sends mail through Cloudflare Email Service.
- **Stripe.** Handles billing and payment records.
- **GitHub.** Used when you connect a repository. Only GitHub connects today.
- **Google.** Used by the sign-in providers that run through Google.

The list reflects the integrations in the current build. A provider is added here before it receives customer data.

Ask for a data processing agreement (a contract that sets how a third party handles data) before you rely on this list in a contract.
