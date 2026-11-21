---
title: Bring your own template
description: Start a site from a custom Worker you build and upload, instead of a Drupal template.
audience: [developer, agency]
type: written
draft: true
---

This page shows you how to bring your own built Worker as a site. It is for developers.

On the Create a Site page, the Bring Your Own card takes a built Worker you uploaded. The wizard sends you to the upload page, and the site is created from that bundle.

The steps, the file limits and the list of supported bindings (connections from your Worker to Cloudflare resources) are on [create a custom Worker site](/docs/guides/sites/create-a-custom-worker-site). Read that page before you build the archive. A bundle that uses a binding the platform does not support is refused at upload, and the findings name it.

Your organization needs a plan that includes custom code. Without it, the upload is refused.

The same bundle can be used again. Upload it once and create more than one site from its `bundleId`. Updating a site to a newer bundle, and putting an earlier bundle back, are covered on the same page.
