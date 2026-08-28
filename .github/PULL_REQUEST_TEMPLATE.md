# What changed

<!-- One or two sentences. The commit subject becomes a permanent public
changelog line via release-please, so write it in English and in Conventional
Commits form (feat:, fix:, chore:, docs:, refactor:, test:). -->

# Which tests cover it

<!-- Name the test file(s) and the case(s) that fail if this change is reverted.
"Existing tests still pass" is not coverage for new behavior. -->

# Checklist

- [ ] `npm test` passes locally (paste the file/test counts from the run)
- [ ] No new runtime dependency (`dependencies` in package.json stays empty)
- [ ] Exit codes still match the contract in `scripts/errors.mjs` if this
      touches a command's failure path
