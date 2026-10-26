---
name: upgrade-upstream-pi
description: Rebase this Pi fork onto main@upstream, resolve a conflicted local stack oldest-first with jj new/fix/squash, upgrade and validate pi-kit and agent-fixes against the rebased API, reinstall agent-fixes and its Pi extension, and commit each repository's changes. Use when Amar asks to upgrade or rebase the local Pi stack onto upstream.
---

# Upgrade the Local Pi Stack

Upgrade three repositories as one compatibility operation:

1. `/Users/amar/repos/ext/pi`
2. `/Users/amar/repos/amar/pi-kit`
3. `/Users/amar/repos/amar/agent-fixes`

Use Jujutsu exclusively. An upstream upgrade includes fetching the latest upstream state unless Amar explicitly requests an offline or cached-state operation. Do not push or publish unless Amar separately asks. Preserve unrelated working-copy changes in every repository.

## 1. Snapshot the Starting Shape

In each repository, read its instructions and inspect `jj status`. In Pi, record:

- the change ID at `@`
- the parent at `@-`
- whether `@` is an empty child or carries unrelated changes
- the local stack from `main@upstream..@`

Do not turn unrelated working-copy changes into upgrade commits.

## 2. Fetch and Rebase Pi

Fetch upstream after recording the starting shape:

```bash
jj git fetch --remote upstream
```

Read the newly fetched upstream commits and relevant Pi release commits before rebasing, especially changes overlapping the local stack. Identify semantic combinations that must survive conflict resolution; never choose a side mechanically.

Use the refreshed `main@upstream`:

```bash
jj rebase -b @ -o main@upstream
```

For an explicitly offline or cached-state operation, skip fetching and report that upstream freshness was not checked. If fetching fails, report the failure rather than treating cached state as current upstream.

Read the output. `jj rebase` can exit successfully while producing conflicts.

Resolve conflicted commits oldest-first. For each conflicted commit:

```bash
jj new <oldest-conflicted-change>
# edit conflicted files directly
# run focused validation
jj squash
```

Then repeat with the next oldest conflict.

Rules:

- Never use `jj resolve`; edit conflict markers directly.
- Read each source file completely before a broad edit. For changelogs, read the complete `[Unreleased]` section.
- Preserve both upstream behavior and the local commit's intent.
- Adopt upstream renames and substrate changes rather than recreating obsolete local wiring.
- For generated locks: resolve the manifest first, then regenerate. Use `npm install --package-lock-only --ignore-scripts` for the root lock and the repository's shrinkwrap/install-lock scripts for generated coding-agent locks.
- Run focused tests before each squash when the resolution changes behavior.
- After a squash, inspect the rebase output: descendants may auto-resolve, or the next conflict may move.

For the Claude Agent SDK stack specifically, retain all of these unless later upstream work genuinely supersedes them:

- model-specific SDK streaming through the current Agent stream-function contract
- durable intermediate `committedMessages`
- executable Pi tools, hooks, and session `cwd`
- SDK providers alongside the normal model catalog
- persisted and live usage accounting

When all commits are clean, run focused tests for every touched local feature and then:

```bash
npm run check
```

Do not run `npm test` or `npm run build` unless Amar asks.

Confirm the entire `main@upstream::local-tip` chain is conflict-free.

## 3. Restore the Pi Working Copy Correctly

Restore the starting working-copy relationship without losing unrelated changes.

- If the original `@` carried unrelated changes, return to that rebased change with `jj edit <original-change-id>` and verify its parent is the rebased local tip.
- If the task should end with a clean working copy above the local tip, use:

```bash
jj new <local-tip>
```

Do **not** use `jj edit <local-tip>` for the clean-child case. Editing the tip makes `jj status` display that commit's entire diff as working-copy changes.

## 4. Install the Rebased Pi Build

After Pi's focused tests and `npm run check` are clean, install the rebased checkout in a versioned directory:

```bash
revision="$(jj log -r @- --no-graph -T 'commit_id.short()')"
npm run release:local -- \
  --out "/Users/amar/.local/share/pi-local/upstream-$revision" \
  --skip-check \
  --skip-test
```

Inspect the current `pi` launcher first. Do not replace or force-remove the `pi-local` parent: existing launchers and running processes can reference versioned children there. Verify the new installation before updating the launcher to its `bun/pi`; preserve its existing argument and process semantics. Keep earlier installations available to running sessions.

The skip flags are valid only because this workflow already ran the checks and tests against the same committed tree. This installation is part of the upgrade, not an optional follow-up.

Verify the installed Node and Bun launchers report the expected version and start successfully before upgrading dependent extensions.

## 5. Upgrade pi-kit

In `/Users/amar/repos/amar/pi-kit`:

1. Preserve live `config/models.json` and `config/settings.json` edits unless an upgrade explicitly requires changing one of their exact hunks.
2. Pin `devDependencies["@earendil-works/pi-coding-agent"]` to the upstream Pi release version now underlying the local stack.
3. Refresh dependencies and the lockfile without lifecycle scripts:

```bash
npm install --ignore-scripts
```

4. Run:

```bash
npm run check
```

Commit only `package.json`, `package-lock.json`, and any deliberate compatibility edits. Use `jj-hunk` if an upgrade shares a file with unrelated work.

## 6. Upgrade agent-fixes

In `/Users/amar/repos/amar/agent-fixes`:

1. Read the AF knowledge routed to the files being changed.
2. Validate `src/agent/pi/extension.ts` against the upgraded Pi packages using a throwaway TypeScript project under `/tmp`; do not add package-management scaffolding to agent-fixes just for this check.
3. Fix actual API/type incompatibilities in the source extension. Keep runtime capability detection where AF intentionally supports both the public Pi release and this fork's additional APIs.
4. Run the repository gate:

```bash
just check
```

Commit only the AF compatibility changes. Verify the committed diff with `jj show @- --stat`.

## 7. Install AF and Its Pi Extension

After AF's committed source and gate are clean, install the exact checkout:

```bash
cd /Users/amar/repos/amar/agent-fixes
cargo install --locked --path .
af install pi
```

`cargo install` must use `--locked`. The second command installs the Pi extension embedded in that newly built AF binary.

Verify that the installed entry point matches `src/agent/pi/extension.ts`. The package installer writes `~/.pi/agent/extensions/agent-fixes/index.ts`; older installs may use `~/.pi/agent/extensions/agent-fixes.ts`. Verify the managed sibling modules too. Existing Pi processes may require an extension reload or restart before using the installed source.

## 8. Commit Pi and Report

Add this skill or any other new Pi-side compatibility files in a dedicated local commit using explicit paths. Never absorb unrelated working-copy changes.

For each repository:

- use a real, scoped commit message
- verify `jj show @- --stat`
- leave a clean child with `jj new` when no unrelated working-copy change must remain active
- do not push

Report:

- rebased Pi range and remaining conflicts (normally none)
- focused test counts and `npm run check`
- local Pi release installation and launcher verification
- pi-kit version bump and check result
- agent-fixes compatibility changes and `just check`
- `cargo install --locked --path .` result
- `af install pi` result
- commit change IDs for all repositories
- any preserved unrelated working-copy changes
