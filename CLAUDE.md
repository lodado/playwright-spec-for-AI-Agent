# CLAUDE.md

Guidance for agents working in this repository.

## Release / Versioning (required on every PR)

This is a Changesets-managed pnpm monorepo. The two published packages are
`playwright-spec-for-ai-agent` and `@lodado/personaut`; everything else is
private (`"private": true`).

**Every PR that changes a published package must bump its version.** Before
opening the PR:

1. Add a changeset describing the change and its bump level:
   - `patch` — bug fix or internal change, no API impact.
   - `minor` — backward-compatible feature or new capability.
   - `major` — breaking change to a package's public API.

   Create `.changeset/<name>.md`:

   ```md
   ---
   "playwright-spec-for-ai-agent": minor
   ---

   One-line summary of the change.
   ```

   Only list the published packages you actually changed.

2. Apply it so the PR carries the version bump:

   ```bash
   pnpm changeset version
   ```

   This updates each package's `version` in `package.json`, writes its
   `CHANGELOG.md`, and consumes the changeset file. Commit those edits with your
   change.

Do not open a PR touching a published package without a version bump. Private
packages need no changeset.

## Verifying

The app package `playwright-spec-for-ai-agent` has no lint/typecheck script — its
source is `.mjs`. Its full gate is:

```bash
cd apps/playwright-spec-for-ai-agent && pnpm test   # vitest run
```

Run it and report the actual output before claiming work is done.
