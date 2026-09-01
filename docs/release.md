# Release and documentation versioning

Codex Channel Bridge uses one repository-wide version for the Supervisor, CLI,
all workspace packages, deployment assets, and documentation. The root
`package.json` is the source of truth. `package-lock.json`, every workspace
manifest, internal workspace dependency pins, `docs/VERSION`, and
`docs/zh/VERSION` are checked mirrors.

## Version model

Versions follow Semantic Versioning without build metadata:

- `MAJOR.MINOR.PATCH` is a stable release.
- `MAJOR.MINOR.PATCH-alpha.N`, `-beta.N`, or `-rc.N` is a prerelease.
- `MAJOR.MINOR.PATCH-dev` identifies unreleased work on `main` and must not be
  tagged or published.

Before `1.0.0`, a breaking configuration, persisted-state, administration,
Channel, or downstream-development contract increments `MINOR`. After `1.0.0`,
it increments `MAJOR`. Backward-compatible capability additions increment
`MINOR`; backward-compatible fixes and documentation corrections increment
`PATCH`. A release that changes the tested Codex matrix or Profile schema must
say so in the changelog even when the public Bridge API is unchanged.

All packages remain lockstep-versioned. Independent package versions would add
compatibility combinations without improving deployment, because the supported
unit is one Supervisor installation.

## Documentation guarantee

The documentation shipped in a release tag is the only authoritative manual
for that release. The Git tag pins code, deployment files, English and Chinese
documents, changelogs, and version files in one immutable tree.

Every behavior or configuration change must update the relevant English file
and its matching `docs/zh/` file in the same pull request. Links from a release
must target that tag, not `main`. A documentation-only correction for a released
version is a new patch release; an existing tag and GitHub Release are never
rewritten.

`npm run release:check` fails when package, lockfile, internal dependency, or
documentation versions differ. With `--tag=vVERSION`, it also requires a
releaseable version, an exact tag match, and matching English and Chinese
changelog sections.

## Release contents

Each GitHub Release contains:

- the annotated `vVERSION` tag;
- release notes extracted from `CHANGELOG.md`;
- `codex-channel-bridge-VERSION.tar.gz`, created from the tagged Git tree;
- a SHA-256 checksum for that archive;
- the complete English and Chinese documentation inside the archive.

The first release mechanism does not publish npm packages or a container image.
Workspace packages are private implementation units, and the checked source
archive already supports native and Docker builds. Add another distribution
channel only when its ownership, signing, retention, and rollback contract are
defined.

## Prepare a release

1. Confirm the target scope and compatibility impact. Move completed entries
   from `Unreleased` into `## [VERSION] - YYYY-MM-DD` in both `CHANGELOG.md` and
   `docs/zh/CHANGELOG.md`. The two sections must describe the same changes.
2. Update every affected operator, user, adapter, migration, and developer
   document in both languages. Record hard-to-reverse decisions in an ADR.
3. Synchronize the repository version:

   ```sh
   npm run release:prepare -- 0.2.0-rc.1
   ```

4. Review the complete diff, then run the deterministic release gates:

   ```sh
   npm run release:check -- --tag=v0.2.0-rc.1
   npm run check
   npm run test:control-contract
   npm run test:supervisor-contract
   ```

5. Run the protocol, platform, and real Channel acceptance required by the
   changed paths. A stable release must have recorded release-candidate evidence
   for every platform and provider capability it claims. An unverified target
   remains explicitly unsupported or incomplete in the release notes.
6. Commit the reviewed release change. Create a signed annotated tag when a
   maintainer signing key is configured; otherwise create an annotated tag and
   state that it is unsigned:

   ```sh
   git tag -s v0.2.0-rc.1 -m "Codex Channel Bridge v0.2.0-rc.1"
   git push origin main
   git push origin v0.2.0-rc.1
   ```

   The unsigned fallback is:

   ```sh
   git tag -a v0.2.0-rc.1 -m "Codex Channel Bridge v0.2.0-rc.1"
   ```

7. The GitHub workflow reruns the release gates, rejects a lightweight or
   mismatched tag, creates the archive and checksum, and publishes the GitHub
   Release. Verify its notes, checksum, and downloadable documentation before
   announcing it.

Repository administrators should protect `main`, require the verification job
before merge, and use a tag ruleset that restricts `v*` creation to release
maintainers and blocks tag update or deletion. Repository settings complement
the in-repository checks; they do not replace them.

## Stable release and prerelease policy

Use `rc.N` for end-to-end acceptance of the exact intended stable tree. A
stable tag must point to a commit whose contents differ from the accepted
release candidate only by approved release metadata or fixes that were tested
again. `alpha` and `beta` may expose incomplete capabilities, but their release
notes must name those limits.

Never move, delete, and recreate a published tag to repair a release. Publish a
new prerelease number or patch version. Keep `main` on a `-dev` version after a
stable release so its documentation cannot be mistaken for the released
manual. Immediately after publishing `v0.2.0`, for example, prepare the next
development line with `npm run release:prepare -- 0.3.0-dev` and commit that
version-only transition on `main`.

## Upgrade and rollback

Read every intervening changelog section before upgrading. If a release changes
the Bridge schema, complete the explicit migration plan, external snapshot, and
apply workflow in [`migrations.md`](migrations.md). A binary downgrade is valid
only when the target release declares the current Bridge schema compatible;
otherwise restore the pre-migration snapshot and the earlier tagged release.

Rollback never means changing a tag. It means stopping the current Supervisor,
restoring the documented compatible state when necessary, deploying an earlier
immutable release, and completing its acceptance checks.
