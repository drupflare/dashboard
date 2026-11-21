---
title: Restore onto a bastion
description: Restore an exported site onto a bastion node you run yourself.
audience: [self-hosting-operator]
type: written
draft: true
---

Restoring to a bastion node (a server you run yourself) is not available yet as a written procedure. The steps to install a bastion are not in the documentation yet. See [Install a bastion](/docs/guides/self-hosted/install-bastion), which says what is missing.

What you can do now:

1. Export the site's backup as SQL. See [Export your site](/docs/guides/sites/export-your-site).
2. Keep the export with the site's code from its repository.

The restore step itself depends on the bastion install, which is not written. Do not plan a cutover (the switch to the new server) on this path yet.
