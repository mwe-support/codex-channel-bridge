# Repository Cutover

Status: completed on 2026-08-26.

At cutover, this directory became an independent repository on `main` without a remote; the user may subsequently configure this standalone project's remote. It was cut from a detached exploratory worktree at legacy commit `0060ee641de85708114f7daf305bcf7700d7de90`; the old remote and history were not retained. This checklist remains as the cutover record and as the procedure to audit or reproduce the boundary.

## Preserve

The following files were copied to a verified staging location before changing the old `.git` link, and their SHA-256 digests matched before the intentional post-cutover status update to this checklist:

- `AGENTS.md`
- `CONTEXT.md`
- `docs/adr/`
- `docs/research/codex-native-thread-history-retrieval-and-compaction.md`
- `docs/research/github-codex-channel-bridge-landscape.md`
- this checklist

## Replaced or created

- Replace the inherited `README.md` with a Codex Channel Bridge README.
- Create the Apache-2.0 `LICENSE` selected in ADR 0006.
- Create `NOTICE` for project attribution; add legacy attribution only after an actual file-level reuse decision.
- Create a project-specific `.gitignore`.

## Excluded

These inherited paths were not copied into the independent repository:

- `plugins/`
- `deploy/`
- `mcp/`
- `scripts/`
- the inherited `README.md`
- `docs/architecture.md`
- `docs/development-log.md`
- `docs/macos-hermes-codex-deployment.md`
- `docs/operations.md`

The original Hermes checkout remains the reference source. Do not create a legacy-code mirror inside the new repository.

## Procedure used

1. Re-scan the worktree and reconcile every path against the preserve, replace, and exclude lists. Stop if an unclassified file contains unique work.
2. Copy preserved files to a staging location outside the worktree and record SHA-256 digests.
3. Resolve the exact linked-worktree Git directory and record the current branch, commit, and remote for provenance only.
4. Remove only the linked-worktree association; never reset or delete the parent Hermes repository.
5. Recreate the project path, restore only preserved files, and verify every digest.
6. Write the replacement README, LICENSE, NOTICE, and `.gitignore` before staging.
7. Initialize a new repository on `main` without a remote. Inspect the complete staged file list and confirm no excluded path or credential is present.
8. Create one design-baseline commit. Configure a remote only after the user supplies the independent repository destination.

## Completion criteria

- `git branch --show-current` returns `main`.
- `git remote -v` returns no entries.
- Repository history contains only the new project baseline and later project commits.
- The preserved-file digests match the pre-cutover record.
- No excluded legacy path is tracked.
- README, LICENSE, NOTICE, and `.gitignore` describe the standalone project.
- Searches for Hermes or OpenClaw references return only intentional architectural rationale, ADRs, research citations, or attribution—never runtime imports, deployment dependencies, or installation instructions.
