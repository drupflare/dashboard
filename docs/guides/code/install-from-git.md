---
title: Install from Git
description: Attach one branch of a repository to a site at a module, theme or profile path, and set how often the site pulls it.
audience: [developer]
type: written
draft: true
---

This page shows you how to have a site pull a module, theme or profile from a Git repository. It is for developers.

You can keep a module, theme or profile in a Git repository and have a site pull it. The site reads one branch of the repository and writes it to a path you choose.

Connect the provider first. See [connect a repository](/docs/guides/code/connect-a-repository).

## Attach a repository

On Integrations, fill in the attach form and submit it with Attach Repository:

- **Connection.** The connection that can read the repository.
- **Repository.** Pick it from the list. The connection must be able to read it.
- **Branch.** Filled in with the repository's default branch. Change it if you need another.
- **Mount Path.** Where the code goes on the site. It must start with `modules/`, `themes/` or `profiles/`, such as `modules/custom/example`.
- **Pull Every (Minutes).** How often the site checks the branch. The minimum is 5 minutes, the maximum is 10,080 minutes (7 days), and the default is 60 minutes.

## How pulls run

The site checks each attached branch on its interval. After a failed check it waits longer before it tries again. A pull can also be started on demand through the API, with the pull route for that remote.

The result of the last pull is saved on the remote, so you can see whether it passed.

## Limits

A mount path outside `modules/`, `themes/` or `profiles/` is refused. So is a branch name the dashboard rejects, and a repository the connection cannot list.
