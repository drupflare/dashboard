---
title: Estate report reference
description: Each field in an estate assessment report and what it measures.
audience: [central-it]
type: written
draft: true
---

This page lists every column, class and state in an estate assessment, and what each one means. For the steps to run an assessment, see [Assess an estate](/docs/guides/migration/assess-an-estate).

## Inventory columns

The inventory is a CSV file with a header row, or a JSON file that holds a `sites` array or a bare array of sites. Header names are matched without regard to case, and a space or a hyphen counts as an underscore. A column this page does not read is ignored and listed once in the check result.

| Column          | Required | Meaning                                                                           |
| --------------- | -------- | --------------------------------------------------------------------------------- |
| `hostname`      | Yes      | The public address of the site. An IP address is refused. Up to 253 characters.   |
| `aliases`       | No       | Other public addresses of the same site, separated by semicolons. Up to 40 a row. |
| `server`        | No       | The host the site runs on. Helps tell apart rows that describe the same site.     |
| `docroot`       | No       | The document root on the server. Up to 200 characters.                            |
| `site_dir`      | No       | The site directory under the document root. Up to 200 characters.                 |
| `database_host` | No       | The host of the site's database.                                                  |
| `database_name` | No       | The name of the site's database. Up to 200 characters.                            |
| `table_prefix`  | No       | The table prefix the site's database uses.                                        |
| `site_uuid`     | No       | The site's uuid. When present, it is the strongest key for telling sites apart.   |
| `cms`           | No       | One of `drupal`, `wordpress`, `joomla` or `unknown`.                              |
| `version`       | No       | The version the owner knows the site runs. Up to 40 characters.                   |
| `owner_note`    | No       | A note kept in the report. Up to 300 characters. It does not change the check.    |

A row without a hostname is left out and listed with its line number and the reason. The rest of the file is still checked.

## Report columns

The CSV export lists the inventory columns first, then these columns. Uploading the export again as an inventory works, and the report columns are not reported as ignored.

| Column       | Meaning                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `number`     | The row number, in the order of the inventory.                                                                             |
| `class`      | The migration class of the site. See [Classes](#classes).                                                                  |
| `state`      | How far the check of this row got. See [States](#states).                                                                  |
| `basis`      | What the identity of the site rests on: `survey`, `columns` or `hostname`. See [Identity](#identity).                      |
| `reconciled` | `yes` when the identity came from a survey or from identity columns. `Not reconciled` when it rests on the hostname alone. |
| `findings`   | Each finding as its title and its detail, joined with `\|`. See [Findings](#findings).                                     |
| `missing`    | The one thing the check needs before it can place the site, when there is one.                                             |
| `effort`     | Always `Not estimated`. See [What is not measured](#what-is-not-measured).                                                 |

## Classes

Each site has one class.

| Class             | Meaning                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready             | The site runs Drupal 11, and every finding is automatic or for information only.                                                                                                |
| Automatic Upgrade | The site runs Drupal 10 or older. The row reads **Upgrade comes first**, because the upgrade tool is not available yet.                                                         |
| Needs Decision    | At least one finding needs your choice, such as cached Redis data or a database shared with another site.                                                                       |
| Unsupported       | The site is WordPress or Joomla. It also covers Drupal newer than 11, missing files, and a database larger than the restore limit. A WordPress row reads **Not supported yet**. |
| Information       | The check could not tell from outside what the site is, and no survey ran. This is a state, not a verdict. The report says what would settle it.                                |

## States

Each row also has a state.

| State           | Meaning                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting         | The row has not been checked yet.                                                                                                             |
| Checking        | The row is being checked.                                                                                                                     |
| Checked         | The check of the row is complete.                                                                                                             |
| Needs Access    | A server survey needs something the owner has not supplied: a key for the server, or a confirmed host key. The report names the missing item. |
| Needs Proof     | The domain is not proven to belong to the organisation, and the run has used its public checks on unproven domains.                           |
| Could Not Check | The check of the row failed. The row carries a plain reason.                                                                                  |
| Skipped         | The assessment was cancelled before this row was checked.                                                                                     |

A retry re-checks only the rows that are not in a final state. Checked, Needs Access, Needs Proof and Skipped rows are kept as they are.

## Findings

A finding is one specific thing the check found about a site. Each finding has a status.

| Status          | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| Automatic       | The migration carries this over without a choice from you.              |
| Requires Choice | You decide how this is handled. The row is in the Needs Decision class. |
| Unsupported     | This part of the site cannot be moved today.                            |
| Information     | The finding is for your information and does not change the class.      |

## Identity

The identity of a site decides which rows describe the same site.

| Basis      | Meaning                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `survey`   | The identity was read from the server during a survey.                                                                                            |
| `columns`  | The identity came from identity columns in the inventory: the site uuid, or the server, document root, site directory, database and table prefix. |
| `hostname` | The identity rests on the lowercased hostname alone. The report marks the row **Not Reconciled**.                                                 |

Two rows with the same site uuid, or with the same host, site directory, database and table prefix, are one site. Their hostnames merge into aliases. Two rows that share only a database host and name are two sites, and each carries a shared database finding that names the other row.

A hostname that appears in two different sites is reported once as a duplicate domain on the first row. The second row refers to it.

## Report counts

The counts table at the top of a finished report shows these values.

| Count             | Meaning                                                         |
| ----------------- | --------------------------------------------------------------- |
| Sites             | The number of sites after the rows were matched to each other.  |
| By class          | The number of sites in each class.                              |
| By state          | The number of rows in each state.                               |
| Not reconciled    | The number of sites whose identity rests on the hostname alone. |
| Shared databases  | The number of databases used by more than one site.             |
| Duplicate domains | The number of hostnames that appear in more than one site.      |
| Surveyed          | The number of sites whose identity was read from a server.      |

## What is not measured

The report states only what the check read. These values are never estimated, and every row and the report header says **Not estimated**:

- Effort, in hours or in money, for a migration.
- The migration window.
- The cost to a customer.

The reason given is that effort needs a measured run, and an assessment only reads the site.

## Limits

These bounds apply to every assessment. They protect the request and the row table, and they are not plan limits.

| Limit                                          | Value                                                  |
| ---------------------------------------------- | ------------------------------------------------------ |
| Rows in one inventory                          | 1,000                                                  |
| Text in one inventory                          | 1 MiB                                                  |
| Public checks on an unproven domain in one run | 5. The other sites on that domain stop at Needs Proof. |
| Rejected rows shown in a check                 | 200. The check still reports the total.                |
