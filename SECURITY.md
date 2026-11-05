# Security Policy

## Supported Versions

Security fixes go into the latest release only.

## Reporting a Vulnerability

Do not open a public issue for a vulnerability. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/drupflare/dashboard/security/advisories/new), or
by email to the maintainer at <me@gmitch215.xyz>.

Include the steps to reproduce and what an attacker gains. Do not include credentials or another
person's data in a report; a redacted request or a description is enough.

The maintainer confirms the report, works on a fix in private, and publishes a GitHub security
advisory with the patch release. Reporters are credited in the advisory unless they ask not to be.

## Scope

In scope: the dashboard in this repository, including its API, sign-in, permission checks and the
dispatch Worker.

Out of scope, with where to send it:

- a vulnerability in a Drupflare site's Worker or runtime: [drupflare/worker](https://github.com/drupflare/worker/security/advisories/new)
- a vulnerability in Drupal core or a contributed module: the
  [Drupal Security Team](https://www.drupal.org/drupal-security-team)
- a vulnerability in the Cloudflare platform: Cloudflare, through its
  [vulnerability disclosure program](https://hackerone.com/cloudflare)
- findings that need physical access, social engineering or a denial of service by volume alone
