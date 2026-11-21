---
title: Connect your server
description: Give Drupflare SSH access to the Drupal server it will read, confirm the host key and run the survey.
audience: [developer, central-it]
type: written
draft: true
---

This page shows you how to connect the import wizard to your server. It is for owners importing a site.

The import wizard connects to your server over SSH and reads it. It has four steps.

## 1. Add the server

Enter the host name or address, the SSH port, the user name, and the Drupal folder on the server. The port is 22 unless you change it.

The form then shows a public key. Add that line to the `authorized_keys` file of the user you named. Drupflare uses the key once and deletes it.

## 2. Confirm the host key

Drupflare shows the server's host key. Check that it matches your server before you continue.

## 3. Check the server

Drupflare reads the site and shows the result as a dossier. The read does not change the server. See [read the dossier](/docs/guides/migration/read-the-dossier).

## 4. Name and start

Name the new site and start the import. The copy starts only after you do this.
