---
title: Assess an estate
description: Check a list of Drupal sites and sort each one into a migration class.
audience: [central-it]
type: written
draft: true
---

An estate assessment reads a list of sites and places each one in a migration class. It answers one question for each site: is this site ready to move, does it need an upgrade or a decision first, or is it outside what the dashboard can move today.

The assessment changes nothing on any site. It reads each site from the outside, and it does not write to the server, the database or the files.

## Before you start

Prepare an inventory file. It is a CSV file with a header row, or a JSON file that holds a `sites` array or a bare array of sites. The [report reference](/docs/guides/migration/estate-report-reference) lists the columns and the rules for their names.

Only `hostname` is required. Add the other columns when you know them. The server, the site directory and the database let the check tell apart rows that describe the same site.

An inventory holds up to 1,000 rows and up to 1 MiB of text.

## Run an assessment

1. Open **Assess an Estate** in the dashboard.
2. Choose the inventory file, or paste its text into the box.
3. Select **Check the Inventory**. The page reads the file and shows the number of rows, the number of sites, and the rows it left out. Each left-out row has its line number and the reason.
4. Fix the rows that were left out, if you want them checked, and check the inventory again. Editing the text clears the result, so the check always matches the text you send.
5. Select **Start the Assessment**. The page opens the assessment.

The assessment page shows one of these states:

- **Preparing**: the inventory is being read. No site has been checked.
- **Checking N of M**: N sites of M have been checked. The page updates while the run goes on.
- **Finished**: every site has been checked, and the report is complete.
- **Cancelled**: you stopped the run. Sites already checked keep their results, and the rest are skipped.
- **Could Not Finish**: the run stopped before every site was checked. Start a new assessment to try again.

## Read the report

The report has two parts. The counts table shows how many sites fall in each class. The sites table lists every site, and you can filter it by class, by state, or by text in the hostname.

Each site has one class. A site can also have findings, which are the specific things the check found, such as a shared database or cached data that needs a decision.

The report does not estimate effort, time or cost. Every report and every row says **Not estimated** for those values. The reason is that effort needs a measured run, and this assessment only reads the site.

## Export and print

- **Export CSV** downloads every row as one file. The inventory columns come first, so the file can be uploaded again as an inventory.
- **Print Report** opens the print dialog. The page hides the navigation and the controls and prints the report.

## What the check measures and what it does not

The check reads each site from the outside, with the same public check the preflight uses. It reads the site's response, not its files or database.

The page checks each site this way only. A server survey over SSH is not available from this page yet, so no row reads the server, and the report marks each row as identified from its hostname unless the inventory names a site uuid, a server, or a database.

Ownership of a domain is not proven from this page. The check reads up to five sites on a domain whose ownership is not proven in one assessment. The other sites on that domain stop at **Needs Proof**.

The assessment does not measure these things:

- The effort, hours or cost of a migration.
- The window in which a migration can run.
- The content, users or traffic of a site beyond what its public response shows.
- Migration of WordPress and Joomla sites. The report puts a site it identifies as one of them in the unsupported class, and its row reads **Not supported yet**.

## Reconciling sites

Rows that describe the same site are counted once. The check uses the site uuid first, then the server, document root, site directory and database when they are given. A site described only by its hostname is marked **Not Reconciled**. Its identity rests on the hostname, and the report says nothing was read from the server to confirm it.

A hostname that appears in two different sites is reported once as a duplicate domain on the first row, and the second row refers to it. Nothing is dropped silently.

## Related

- [Estate report reference](/docs/guides/migration/estate-report-reference) lists every column, class and state in the report.
- [Read the dossier](/docs/guides/migration/read-the-dossier) covers the dossier for one site, which carries more detail than a row.
