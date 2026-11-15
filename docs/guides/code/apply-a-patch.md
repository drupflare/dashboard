---
title: Apply a patch
description: Send changed files for a custom module, theme or profile to a site, and go back to the earlier files if the change goes wrong.
audience: [developer]
type: written
draft: true
---

The dashboard sends files, not a diff. Apply the patch to your own copy of the module, theme or profile first, then send the result from Code History with Deliver an Edit. It works the same on a managed site and on a self-managed site that Drupflare holds access to.

## Send an edit

1. Open Code History from the site page and choose Deliver an Edit.
2. Pick the type, enter the machine name, and choose the folder that holds the whole module, theme or profile. You can also add a single file by pasting its path and content.
3. Write a note that says what the edit changes, then choose Deliver the Edit.

Send the complete set of files. The site keeps what you send and removes any file of that name you leave out.

## What the dashboard checks

- Paths must sit in `modules/custom/<name>/`, `themes/custom/<name>/` or `profiles/custom/<name>/`, with plain segments and no `..`.
- Every file in one edit belongs to the same module, theme or profile.
- Files must be UTF-8 text. Images and other binary files cannot be sent yet.
- A request can hold up to 1 MiB. Each problem is shown next to the file it belongs to.
- The plan must include custom code, the site must be an active Drupal site, and Drupflare must hold access to it.

## What happens next

A restore point of the site database is taken first. The site then boots with the new files. If it refuses them, it puts the earlier files back and the edit stops with the reason. An edit that passes is checked against the site's health route and added to Code History with its note and its files.

## Go back to an edit

Choose Roll Back on an edit in Code History. The files of that edit go back on the site. Only that module, theme or profile changes. Your content and settings stay as they are now. An edit recorded without its files has no Roll Back button.
