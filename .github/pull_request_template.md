## Summary

What changes and why.

## Verification

- [ ] `bun run typecheck` passes
- [ ] `bun run test:unit` passes, and `bun run test:bindings` passes if bindings changed
- [ ] Specs for the changed behavior are in this change, and each bug fix has a regression test that fails without the fix
- [ ] `bun run prettier:check` passes
- [ ] For UI changes, the screen was checked in `bun run dev` in a browser
- [ ] For changes the e2e lane covers, `bun run build:test` ran before Playwright
- [ ] The full suite ran only if shared fixtures, config or dependencies changed
- [ ] For a user-visible feature, the change leaves evidence: an Analytics Engine event or a log line, a test, and a docs page

## Restart

What must restart for this change to take effect, with the commands. Write "Nothing" if nothing restarts.
