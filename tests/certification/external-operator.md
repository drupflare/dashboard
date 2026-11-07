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
5. **Read the site page.** Open the site in the dashboard. Expect its status, hostname, a health verdict, a readiness level, an update state, a backups panel and the operation that created it.
6. **Back up the site.** Press "Back Up Now" in the backups panel and follow the progress screen to the end. Expect a backup in the table, marked "Not Verified Yet".
7. **Create a second site** the same way as step 2.
8. **Restore the backup into the second site.** Press "Restore" on the backup, pick the second site, tick the box and confirm. Follow the progress screen. Expect the second site to serve the first site's content afterwards.
9. **Download the backup.** Press "Download" on the backup in the same signed-in browser session. Expect one SQL file and no secrets in it.
10. **Read the health.** On the first site's page, tell the observer in your own words what the health verdict and each line under it mean, and what the readiness list says is still not checked. Expect the verdict "Healthy" and a readiness level of "Live".
11. **Update the site.** If the site page says an update is available, press "Update", confirm and follow the progress screen. Expect the site to keep serving and the page to read "Up to date" afterwards.
12. **Delete the second site.** On its page press "Delete Site", type its name and confirm, entering the sign-in code the dashboard asks for. Follow the progress screen. Expect "Site deleted" and the site gone from the list.

## Not in this build

These have no screen or no way to produce them on demand, so the run cannot cover them. They are listed so nobody reads their absence as a pass.

- Understanding a health warning. The tree shows a warning only when a site reports one, and a fresh site does not. The run covers reading a healthy tree. No button repairs a warning yet.
- Updating when no newer release exists. The person running staging puts a newer release in place first. If the page reads "Up to date" at step 11, the observer records that the step was skipped.
- The person running staging removes the first site and the resources of both afterwards.

## Pass and fail

The run passes when steps 1 to 12 finish with no question from the operator that the docs and the screens could not answer, no step done by the observer, and no error that needed a developer. A restore that times out is a fail, not a retry.

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
| 10   |       |     |                 |                        |      |
| 11   |       |     |                 |                        |      |
| 12   |       |     |                 |                        |      |
