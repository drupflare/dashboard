---
title: Accessibility conformance
description: How the Drupflare dashboard was tested against WCAG 2.2 Level AA, what passed, what is known to be wrong, and what was not tested.
audience: [security-reviewer, central-it]
type: written
draft: true
---

This statement covers the Drupflare dashboard. The dashboard is the web app where organizations sign in, manage sites and billing, and where platform administrators run the admin area. We measured it against WCAG 2.2 Level A and Level AA. This page records what we tested and how, the result for each success criterion, what we know is wrong, and what we did not test.

This is a self-assessment. No third party has reviewed it, and it is not a certification. A VPAT or an Accessibility Conformance Report (ACR) is a separate document. This statement can feed one.

## Scope and release

The product is the Drupflare dashboard. The statement does not cover customer Drupal sites. A site's accessibility depends on the theme, content and modules it runs, and the dashboard does not change them.

The statement also leaves out the sign-in pages that Cloudflare Access and GitHub show, since the dashboard hands off to them. It leaves out the documentation pages, and the email messages the dashboard sends.

The package version is 1.0.0, but no release has been published. This statement covers a pre-release build of 2026-11-21. The results apply to that build only. A later build can differ.

## How we tested

**Automated route audit.** We audited 53 routes: 39 for signed-in and signed-out visitors, and 14 platform administrator pages. Each route was checked at 390 px and 1280 px wide, in light and dark colour schemes. The admin pages also ran with an empty data set and with a loading state. That makes 268 page states. Each state ran in two browser projects: a desktop Chromium project and a Pixel 7 emulation project. The run produced 536 test results, and all 536 passed. No page state had an axe violation at any impact level.

**Tools.** We used axe-core 4.14.1 through @axe-core/playwright 4.14.0, with the rules tagged wcag2a, wcag2aa, wcag21aa and wcag22aa. The tests ran in Playwright 1.64.1. The Chromium version was not recorded for this run. The Pixel 7 project sets the device profile. The audit sets the viewport to 390 or 1280 px in both projects.

**Keyboard checks.** On each audited page, the test presses Tab and checks two things. The skip link must be the first stop. The first ten stops must each show a focus ring. Two flows, sign-in and starting a new site, have their own keyboard tests. Those tests check that the controls can be reached and used by keyboard.

**Unit tests.** Tests check the skip link placement, that scrollable tables can take focus and carry a label, the link colour classes, the error colour tokens, and 19 pairs of text and background colours from the theme. Text pairs must reach 4.5:1. Non-text pairs, such as input borders and the focus colour, must reach 3:1. The final run had 35 unit tests, all passing.

**Code review.** We scanned the source for icon-only buttons, form controls with no label, the document language, heading order, tables with no header, dialogs and motion handling. The scan found three form controls with no label, a missing document language, and scrollable table wrappers that could not take keyboard focus. We fixed all of them in this build.

**Admin pages.** The admin API needs a Cloudflare Access sign-in that the test build cannot provide. We audited the admin pages with stubbed API responses. Real data can render differently. Long names, real error responses and records that only production produces were not audited.

**Not tested.** The following were not tested:

- Screen readers. We did not run NVDA, JAWS, VoiceOver or TalkBack. Reading order, announcements and spoken names are unverified.
- Browsers other than Chromium. The test config defines a Firefox project, but it did not run. Safari and WebKit were not tested.
- Real phones and tablets. The mobile project is an emulation of a Pixel 7, not a device.
- Keyboard use beyond the first ten tab stops on each page and the two flows above. We did not walk every page or every dialog.
- Zoom and text spacing. We did not test at 200 or 400 percent zoom, at 320 px wide, or with text spacing changed. The 390 px audit does not check for horizontal scrolling.
- The 17 dynamic pages that need a real record to load. These include the invitation page, the site detail pages and the operation progress pages.
- Real data on the admin pages, as described above.
- Colour used alone to convey meaning, timed content, drag actions, motion-triggered controls, and authentication steps beyond the sign-in flow.
- Users with disabilities. We did not run any user testing.

## Results by success criterion

WCAG 2.2 removed 4.1.1 Parsing, so this statement covers 55 criteria at Levels A and AA. Each result uses one of these labels:

- **Supports.** The automated or code evidence covers the testable part of the criterion on the audited pages, and we know of no defect. The notes say where that evidence stops.
- **Partially Supports.** We know of a defect that affects part of the product.
- **Does Not Support.** We know of a defect that the criterion covers, and this build does not fix it.
- **Not Evaluated.** We did not check the criterion, or our checks cannot test it.
- **Not Applicable.** The product has no content that the criterion covers.

**Partially Supports:** none recorded. **Does Not Support:** none recorded. These results reflect what we tested. They do not mean the product meets a criterion on every page.

### Supports

| Criterion                   | Level | Evidence                                                                                                                                                                   | Limits                                                                                                             |
| --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1.1.1 Non-text Content      | A     | axe image, SVG and name rules pass on all 268 page states. The code scan found no icon-only buttons. The usage chart has a table alternative, checked by a text-walk test. | axe checks that a text alternative exists, not that it is accurate. Alternatives in site content are out of scope. |
| 1.4.3 Contrast (Minimum)    | AA    | axe colour-contrast rule passes on all 268 page states. The unit tests check 19 text and background pairs from the theme.                                                  | axe checks text on a solid background. Text over images, gradients and hover states was not checked.               |
| 2.4.1 Bypass Blocks         | A     | The skip link is the first tab stop on each audited page and moves focus to the main region. The axe bypass rule passes.                                                   | Checked on the audited pages only.                                                                                 |
| 2.4.2 Page Titled           | A     | The axe document-title rule passes on all 268 page states.                                                                                                                 | Checks that a title exists, not that it describes the page.                                                        |
| 2.4.7 Focus Visible         | AA    | The first ten tab stops on each audited page show an outline or box shadow.                                                                                                | Checks that a ring is drawn, not how it looks. Stops after the tenth were not checked.                             |
| 2.5.8 Target Size (Minimum) | AA    | The axe target-size rule passes on all 268 page states. The sign-in logo link failed until the skip link stopped covering it.                                              | Covers the audited states only.                                                                                    |
| 3.1.1 Language of Page      | A     | The document language is set to English in the app configuration. The axe html-has-lang and html-lang-valid rules pass.                                                    | None.                                                                                                              |
| 4.1.2 Name, Role, Value     | A     | The axe button-name, link-name and ARIA rules pass on all 268 page states. The code scan found and fixed three unlabelled form controls.                                   | Custom components that do not appear on audited pages are not covered.                                             |

### Partially Supports

None recorded. See the known items below. None of them is a recorded failure of a criterion on the audited pages.

### Does Not Support

None recorded.

### Not Evaluated

| Criterion                                       | Level | What we have                                                            | Why it is not evaluated                                                          |
| ----------------------------------------------- | ----- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1.3.1 Info and Relationships                    | A     | axe checks table, list, label and landmark markup on each audited page. | Heading order and dynamic regions were not reviewed in the browser.              |
| 1.3.2 Meaningful Sequence                       | A     | First ten tab stops per page.                                           | Reading order was not checked beyond that.                                       |
| 1.3.3 Sensory Characteristics                   | A     | Nothing.                                                                | Instructions that rely on shape, colour or position were not reviewed.           |
| 1.3.4 Orientation                               | AA    | Nothing.                                                                | Not checked.                                                                     |
| 1.3.5 Identify Input Purpose                    | AA    | Nothing.                                                                | Not checked.                                                                     |
| 1.4.1 Use of Color                              | A     | Nothing for status badges and dots.                                     | Not audited one by one.                                                          |
| 1.4.4 Resize Text                               | AA    | Nothing.                                                                | Not tested at 200 percent.                                                       |
| 1.4.5 Images of Text                            | AA    | Nothing.                                                                | Not reviewed.                                                                    |
| 1.4.10 Reflow                                   | AA    | The 390 px audit.                                                       | No test at 320 px or 400 percent zoom, and no check for horizontal scrolling.    |
| 1.4.11 Non-text Contrast                        | AA    | Input borders and the focus colour meet 3:1 in the theme unit tests.    | Other controls, icons and chart marks were not checked.                          |
| 1.4.12 Text Spacing                             | AA    | Nothing.                                                                | Not tested.                                                                      |
| 1.4.13 Content on Hover or Focus                | AA    | The skip link appears on focus.                                         | Tooltips and popovers from the component library were not tested.                |
| 2.1.1 Keyboard                                  | A     | Sign-in and new-site flows, and the first ten stops per page.           | Other functions were not operated by keyboard.                                   |
| 2.1.2 No Keyboard Trap                          | A     | The first ten stops per page did not trap focus.                        | No full walk.                                                                    |
| 2.1.4 Character Key Shortcuts                   | A     | Nothing.                                                                | Single-key shortcuts were not checked.                                           |
| 2.2.1 Timing Adjustable                         | A     | Nothing.                                                                | Session timeouts and step-up prompts were not tested.                            |
| 2.2.2 Pause, Stop, Hide                         | A     | Motion is turned off when the reduced-motion setting is on.             | Auto-updating content was not reviewed.                                          |
| 2.3.1 Three Flashes or Below Threshold          | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 2.4.3 Focus Order                               | A     | First ten stops per page.                                               | Not checked beyond the tenth stop.                                               |
| 2.4.4 Link Purpose (In Context)                 | A     | axe confirms every link has a name.                                     | Link wording was not reviewed.                                                   |
| 2.4.5 Multiple Ways                             | AA    | Nothing.                                                                | Not reviewed.                                                                    |
| 2.4.6 Headings and Labels                       | AA    | The code scan checked for heading jumps.                                | Labels and heading wording were not reviewed.                                    |
| 2.4.11 Focus Not Obscured (Minimum)             | AA    | The skip link covered the sign-in logo. The fix is in this build.       | Sticky elements, dialogs and overlays were not checked.                          |
| 2.5.1 Pointer Gestures                          | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 2.5.2 Pointer Cancellation                      | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 2.5.3 Label in Name                             | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 2.5.4 Motion Actuation                          | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 2.5.7 Dragging Movements                        | AA    | Nothing.                                                                | Not reviewed.                                                                    |
| 3.1.2 Language of Parts                         | AA    | Nothing.                                                                | Not reviewed.                                                                    |
| 3.2.1 On Focus                                  | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 3.2.2 On Input                                  | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 3.2.3 Consistent Navigation                     | AA    | Nothing.                                                                | Not reviewed across pages.                                                       |
| 3.2.4 Consistent Identification                 | AA    | Nothing.                                                                | Not reviewed across pages.                                                       |
| 3.2.6 Consistent Help                           | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 3.3.1 Error Identification                      | A     | Field errors use an alert role.                                         | Error text in forms was not tested.                                              |
| 3.3.2 Labels or Instructions                    | A     | axe label rules pass on the audited pages.                              | Form steps that the audit did not reach were not reviewed.                       |
| 3.3.3 Error Suggestion                          | AA    | Nothing.                                                                | Not reviewed.                                                                    |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA    | Nothing.                                                                | Billing, deletion and transfer actions were not reviewed for confirmation steps. |
| 3.3.7 Redundant Entry                           | A     | Nothing.                                                                | Not reviewed.                                                                    |
| 3.3.8 Accessible Authentication (Minimum)       | AA    | Nothing.                                                                | Sign-in relies on third-party pages outside this statement.                      |
| 4.1.3 Status Messages                           | AA    | Field errors use an alert role.                                         | Other status messages were not traced.                                           |

### Not Applicable

| Criterion                                                  | Level | Reason                                        |
| ---------------------------------------------------------- | ----- | --------------------------------------------- |
| 1.2.1 Audio-only and Video-only (Prerecorded)              | A     | The dashboard has no audio or video elements. |
| 1.2.2 Captions (Prerecorded)                               | A     | As above.                                     |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A     | As above.                                     |
| 1.2.4 Captions (Live)                                      | AA    | As above.                                     |
| 1.2.5 Audio Description (Prerecorded)                      | AA    | As above.                                     |
| 1.4.2 Audio Control                                        | A     | As above.                                     |

## Known defects and open items

These are the items we know about. None is a recorded failure of a criterion. Each has a plan.

| Item                                                                                                                                                                                                                                                        | Where                                               | Plan                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The footer link to `/docs` leads to a page that does not load. In the test build, the request for the page data returns 404, and the browser logs an error.                                                                                                 | Footer on the public pages                          | Decide how the documentation index is served. Then fix the route or point the link at a page that exists. |
| Colour changes await a visual check. Input borders, muted text, the error red and text links changed to pass contrast.                                                                                                                                      | Light and dark themes                               | Review each change on a real screen in both schemes before release. A different shade may be needed.      |
| Behaviour that needs a browser check: focus return after a dialog closes (this relies on component library defaults), the label on the repository picker, and a possible second `main` landmark. The second `main` was not reproduced on the audited pages. | Dialogs, new site and integrations pages, all pages | Check each in a browser with the keyboard. Then with a screen reader.                                     |
| No screen reader pass.                                                                                                                                                                                                                                      | All pages                                           | Run a screen reader on the sign-in, dashboard and new site pages. Then extend the pass.                   |
| Dynamic routes are not audited.                                                                                                                                                                                                                             | 17 pages                                            | Add test records and extend the audit to these pages.                                                     |
| Admin pages use stubbed data.                                                                                                                                                                                                                               | 14 admin pages                                      | Add a test sign-in for a platform administrator, or record real responses.                                |
| Browser version not recorded.                                                                                                                                                                                                                               | Test run                                            | Record the Chromium version on the next run.                                                              |

## Contact

To report an accessibility problem, email [support@drupflare.com](mailto:support@drupflare.com). Include the page address, your browser and device, and any assistive technology you used.

We update this statement when a release ships and when the open items above close. A VPAT or ACR, if we produce one, will be a separate document that this statement feeds.

The [security review packet](/docs/institutions/security-review-packet) lists the other documents reviewers usually ask for.
