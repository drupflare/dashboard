---
title: Preflight
description: What the public address check reads on a site, and what only a server survey can tell.
audience: [developer, central-it]
type: written
draft: true
---

The address check at `/migrate/preflight` needs no account. You enter a site address and it reports what the site shows to any visitor. It is a first look before you connect a server.

## What it reads

The check requests the page at the address you enter. If the site redirects within the same domain, it follows the redirect. If the redirect leads to another domain, it stops there and tells you.

From that page it reads these things:

- The `X-Generator`, `Server`, `X-Powered-By`, `X-Drupal-Cache`, `X-Drupal-Dynamic-Cache`, `Via` and `Link` response headers.
- Headers that name a host: `X-AH-Environment` for Acquia, `X-Pantheon-Styx-Hostname` for Pantheon, and `CF-Ray` for Cloudflare.
- The generator tag, the script and style paths under `/core/`, `/wp-content/`, `/wp-includes/` and `/media/system/`, and the settings block Drupal 8 and later print.

It then asks for at most three small files on the same host, and only when the page left the question open:

- `/core/CHANGELOG.txt`, whose first line prints the version on Drupal 8 to 11.
- `/CHANGELOG.txt`, which does the same on Drupal 7.
- `/robots.txt`, which can match a default file for Drupal, WordPress or Joomla. A default robots file supports a finding and never names a system on its own.

Altogether that is a handful of ordinary page requests. They carry a `Drupflare-Preflight` User-Agent, no cookies and no login. A run stops after 15 seconds or 1.5 MB. Site owners who want the checks to stop can write to <support@drupflare.com>.

## What it reports

The result gives the system, the version, the host and the signals behind each, with the page that printed any version. A version appears only when a page printed it. A Drupal generator tag usually prints the major version only, so the check reports `11` and not `11.0.1` unless the changelog printed the full number.

The verdict is one of four:

- Worth a server survey: a page printed Drupal 11, and nothing contradicts it.
- Needs an upgrade first: a page printed Drupal 7 through 10. The result says which version, because the import accepts Drupal 11 today.
- Not yet supported: the site looks like WordPress or Joomla.
- Cannot tell from outside: the site discloses nothing, discloses two systems that disagree, or refused the request.

## What it cannot tell

Many sites hide their system and version, and that says nothing against a move. The check cannot see the modules, the database, the files on disk, the PHP version the server runs, or whether the server accepts an SSH connection. A read-only survey of the server answers those, and it is the next step once you have an account.
