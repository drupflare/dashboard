---
title: The discovery document
description: The document the dashboard reads from a site at /.well-known/drupflare, and how the dashboard builds it when a Drupal site does not serve one.
audience: [developer]
type: written
draft: true
---

This page describes the discovery document a site serves to the dashboard. It is for developers building a template.

The discovery document tells the dashboard what a site can do. It lists the site's settings, the routes the dashboard may call, the redirects the site uses and the health words it reports.

## Where it comes from

The dashboard requests `/.well-known/drupflare` from the site's address. It waits 5 seconds at most.

- A valid document is used as it is.
- A `404` means the site does not publish one. For a Drupal site, the dashboard then reads the site's `/settings` route with the site's owner token and builds the document itself.
- Any other error, or a document that does not match the format, is reported as a failed read. The dashboard does not guess the missing parts.

Today Drupal sites do not serve the path, so they take the second route.

## What the document holds

- `v`: the format version, `1`.
- `kind`: the kind of site, such as `drupal`.
- `version`, `releaseId` and `schemaVersion`: the release the site runs. `version` and `schemaVersion` can be `null` when the release is not registered or the data schema has not been read.
- `capabilities`: each feature with a state of `enabled`, `disabled`, `unavailable` or `degraded`, and a reason when it is not enabled.
- `settings`: the setting `schema`, the current `values`, the `provenance` of each value (see below), the layer each setting can be written to, and an `etag` for the set.
- `routes`: the owner routes the dashboard may call. Each has a method, a path, a class (`safe`, `rebuild` or `stateful`) and an auth type.
- `redirects`: paths on the site that send a visitor to a dashboard page.
- `healthVocabulary`: the health words the site uses. For a Drupal site these are `ok`, `info`, `warn`, `error` and `critical`.
- `limits`: numeric limits the site reports, such as the queue size and the largest upload.

A setting provenance is one of `default`, `var`, `kv` or `override`. A setting can be written to the `var`, `kv` or `override` layer, and only the names on the site's override list are writable.
