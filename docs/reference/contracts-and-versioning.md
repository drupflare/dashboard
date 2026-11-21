---
title: Contracts and versioning
description: How the dashboard's wire contracts are versioned, how a client asks for a range, and when an old version stops working.
audience: [developer, self-hosting-operator, central-it]
type: written
draft: true
---

A contract is a wire format (the agreed layout of messages) between the dashboard and another party. Examples are the API, the fleet link with a self-hosted node, and the webhook payloads. Each contract has a major and a minor version, written as `{ major, minor }`.

## Changes within a major version

Within a major version, changes are additive (only added, never removed or changed). New optional fields, new allowed values a reader can ignore, and new routes are allowed. Removing or renaming a field, tightening a type (making its rules stricter), or changing a signing rule (the way messages are signed) needs a new major version.

## Asking for a range

A request names the range of versions it can use in the `Drupflare-Contract` header:

```text
Drupflare-Contract: fleet-link=1.0-1.2
```

The format is `<contract>=<min>-<max>`. The dashboard answers with the range it supports in the same header. A node (a server you run yourself) announces its own range inside its signed challenge response.

## Which versions are accepted

The dashboard accepts its current major version and the previous one. The previous major stays accepted for at least two minor releases of the new major and at least 180 days, whichever ends later.

A client outside the supported range gets `426`. The response uses the standard error body, and `details.supported` lists the range the dashboard accepts. See [status codes](/docs/reference/status-codes).

## Deprecation

Dropping an old major version needs a deprecation notice (a warning that a version will be removed) in these docs and on the admin screen first.
