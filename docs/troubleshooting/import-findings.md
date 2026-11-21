---
title: Import findings
description: What the findings from a server check mean, and the change each one asks for before the import can continue.
audience: [developer, agency]
type: written
draft: true
---

This page helps you read the findings from a Worker import check and fix them. It is for developers.

When you import a Worker project, Drupflare checks the upload first. The check lists findings. Each finding has a title and, when a change is needed, the change to make. The check changes nothing on your server.

## Common findings

- **No entry file is set.** Set `main` in `wrangler.jsonc` to your built entry file (the file that starts your code).
- **The entry file is not in the archive.** Add the built file that `main` names, or fix the path.
- **The entry file is source code.** Build your project and upload the JavaScript it produces.
- **No compatibility date is set.** Set `compatibility_date` to the day you built and tested the code. This date sets how the Workers runtime (the environment your code runs in) behaves.
- **The compatibility date is not a date.** Write it as `YYYY-MM-DD`.
- **The bundle (your built files) is too large, or its files do not match its manifest (the list of files it should hold).** Rebuild the bundle and upload it again.

## Fix and check again

Make the change in your project, build it, and upload it again. The check runs again on the new upload.

A finding that asks for no change is shown for information only.

See [create a custom Worker site](/docs/guides/sites/create-a-custom-worker-site) for the upload steps.
