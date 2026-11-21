---
title: Database console
description: Admin runbook for the read-only database console, what a statement may and may not do, what it masks and what it logs.
audience: [developer]
type: written
draft: true
---

The database console runs read-only queries (lookups that cannot change data) against the platform database. It is for checking facts during an incident or a support case. It is not a general database tool.

## Permissions

Running a query needs the infrastructure permission on the platform and a fresh sign-in. Saving a query for later needs the same. Both are checked on every request.

## What a statement may do

Before the console sends a statement (one query) to the database, it runs its own checks on the text:

- The statement must start with `SELECT`.
- It must be one statement. A trailing semicolon is allowed.
- Words that write, change a connection, attach a file or run more than one statement are refused. The list includes `INSERT`, `UPDATE`, `DELETE`, `PRAGMA`, `ATTACH`, `WITH` and `INTO`.
- Parameters (placeholders for values) are refused, and so are functions outside a short list.
- It can have up to four joins (combinations of two tables) and four selects, and up to 2,000 characters.
- It cannot name a masked column or a denied table, described below.

A refused statement gets an answer that says why. Refused statements are logged too.

## What a result shows

- The console returns up to 200 rows. A 201st row marks the result as truncated.
- Secret columns, such as key hashes, session identifiers and sealed envelopes (encrypted values), show as `[masked]`. The console also refuses a statement that names one of them.
- Some tables hold one-time values or sealed material, such as single-use tokens and owner tokens. The console refuses them outright.
- The answer stops after 5 seconds.

## What is logged

Every statement is written to the platform audit log with its text and the admin who ran it. That includes refused statements. Saved queries are listed with their creator, newest first, up to 100.

## Limits

The checks are a list of rules the code applies before a statement runs. They reduce what a statement can do. They do not replace the read-only access of the database itself, and they do not guarantee that a query is cheap.

Known gaps:

- A comma join, such as `FROM a, b`, is not counted against the join limit. The row cap and the 5-second limit are the only bounds on a large cross product (every row paired with every row).
- The 5-second limit ends the wait for an answer. It does not stop the query that is already running in the database.
- A recursive query is refused, because `WITH` is refused everywhere.
