---
title: Migration overview
description: What moves from an existing Drupal server to Drupflare today, what needs an upgrade first, and what the move does to your server.
audience: [central-it, agency]
type: written
draft: true
---

This page explains how Drupflare moves an existing Drupal site onto the platform. It is for site owners planning a move.

Drupflare can read an existing Drupal site on a server you control and build a managed copy of it. It reads the database and the public files, then builds a new site from them.

## What moves today

Drupal 11 sites on a Linux server that Drupflare can reach over SSH, with a MySQL or MariaDB database.

## What needs an upgrade first

Drupal 7 through 10. Drupflare does not run the upgrade yet, so upgrade the site before you move it. The report for these sites says which version it found.

## What is not supported yet

WordPress and Joomla sites, databases other than MySQL and MariaDB, and sites that keep a private files folder. A site too large for one restore is refused, and the reason is shown.

## What the move does to your server

Nothing. The survey and the copy only read. Drupflare deletes the connection key when the job ends. Your server keeps serving visitors until you approve a cutover (the switch of your address to the new site), and a move never deletes the source.

## What carries over

The database, which holds your content and users, and the public uploaded files. The report lists the modules the site enables and flags anything a database copy does not carry, such as Redis data outside the cache.

## What does not carry over

The private files folder, Drupal code that lives on your server, and anything stored outside the database and the public files. Check the report before you start.

## Steps

1. [Check a site address](/migrate/preflight). This shows what a visitor sees at the address. It needs no account.
2. Create an account. Sign in with a code sent by email, then choose Import From a Server.
3. [Connect your server](/docs/guides/migration/connect-your-server). Add the server, confirm its host key, and read the report.
