---
title: Spool kill path
description: Switch the docs spool off, and know how long browsers can keep serving their copies after that.
audience: [developer]
type: written
draft: true
---

The spool keeps a copy of public pages in the visitor's browser, so repeat views make no request. It covers `/docs`, `/trust`, build assets and nothing that needs a sign-in. The dashboard turns it on only when `NUXT_PUBLIC_SPOOL` is `on`. The default is off.

## Steps

1. Set `NUXT_PUBLIC_SPOOL` to anything other than `on`, or unset it, and deploy (publish the new build). Pages built after that carry no spool script, so new visits do not register the worker (a background script the browser runs).
2. Replace the served `/spool-sw.js` with the stub, and deploy. The stub is not in the repository yet, so this step cannot be done until it is written and tested.

## How long it takes

`/spool-sw.js` is served with `Cache-Control: public, max-age=86400`. The spool 1.0.0 README says a deploy that changes the script's content reaches a browser within one day.

Turning the flag off does not clear copies that browsers already hold. Those copies stay until the browser fetches the changed script, which takes up to one day. Some browsers check sooner. Plan for one day.

Do not describe this as instant.
