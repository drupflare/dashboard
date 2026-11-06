# External Operator Run

One person who did not build the dashboard works through the steps below on the staging dashboard, with an observer who writes things down and does not help. The run tests what exists in this build. A step that needs help, a workaround or a simulated path counts as failed.

## Before the run

The person running staging does these first. None of them belongs to the operator.

1. The staging dashboard and the dispatch Worker run from a worker release commit whose CI is green, and the managed Drupal bundle was built from that same commit.
2. The operator has an email address that can receive a sign-in code, and a staging organisation on a plan that allows a managed Drupal site.
3. Nothing in the `drupflare-test` namespace is used or touched.
4. The observer has the sheet at the bottom of this file open.

The operator gets the dashboard URL and nothing else. No password, no token, no walkthrough.

## Steps

Each step lists what the operator is asked to do and what should happen. The observer records the time, every question the operator asks and every error with its request id.

1. **Sign in.** Open the dashboard and sign in with the email code. Expect the sites page, empty.
2. **Create a Drupal site.** Choose Create a Site, keep Managed, pick Drupal, accept the suggested name and create it. Expect a progress page that names the live machine state and ends with the site URL. No spinner without a state.
3. **Open the site.** Open the site URL. Expect the Drupal front page.
4. **Reach the admin.** Reveal the first admin password (shown once), sign in to the site's admin with it and open the content list. Expect the password to work and a second reveal to be refused.
5. **Read the site page.** Open the site in the dashboard. Expect its status, hostname and the operation that created it.
6. **Back up the site.** Start a backup from the API page at `/api/` (route `POST /api/v1/orgs/{orgId}/sites/{siteId}/backups`, with any unique string as the `Idempotency-Key` header). Poll the returned operation until it finishes. Expect a backup in the list, with `verified` false.
7. **Create a second site** the same way as step 2.
8. **Restore the backup into the second site.** Use `POST .../backups/{backupId}/restore` with the second site's id as `targetSiteId`. Poll the operation. Expect the second site to serve the first site's content afterwards.
9. **Export the backup.** Download it from `GET .../backups/{backupId}/export` in the same signed-in browser session. Expect one SQL file and no secrets in it.

## Not in this build

These belong to the gate and have no screen or route yet, so the run cannot cover them. They are listed so nobody reads their absence as a pass.

- Understanding a health warning. There is no health page.
- Updating a site. There is no upgrade operation.
- Deleting a site. The person running staging removes the two sites and their resources afterwards.

## Pass and fail

The run passes when steps 1 to 9 finish with no question from the operator that the docs and the screens could not answer, no step done by the observer, and no error that needed a developer. A restore that times out is a fail, not a retry.

## Sheet

| Step | Start | End | Questions asked | Errors and request ids | Pass |
| ---- | ----- | --- | --------------- | ---------------------- | ---- |
| 1    |       |     |                 |                        |      |
| 2    |       |     |                 |                        |      |
| 3    |       |     |                 |                        |      |
| 4    |       |     |                 |                        |      |
| 5    |       |     |                 |                        |      |
| 6    |       |     |                 |                        |      |
| 7    |       |     |                 |                        |      |
| 8    |       |     |                 |                        |      |
| 9    |       |     |                 |                        |      |
