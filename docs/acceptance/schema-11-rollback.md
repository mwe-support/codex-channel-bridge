# Schema 11 rollback rehearsal — 0.2.0-rc.1

- Date: 2026-09-05, native macOS.
- Previous immutable binary: `v0.1.0-rc.4`, schema 9.
- Candidate binary: `0.2.0-rc.1`, schema 11.
- Scope: isolated Profile state with no Channel Accounts; the real test Profile
  and its credentials were not read or changed.

The exact previous tag was exported, installed from its lockfile in an owner-only
temporary directory, built, and used to create a schema-9 Profile store containing
one harmless Archive record. The closed SQLite file was copied as the external
snapshot; source and snapshot SHA-256 matched.

The candidate's public migration API planned and applied the composed schema
9→11 path. Inspection returned schema 11 and `quick_check=ok`. The previous
binary then rejected that database with `migration_required`, proving that a
direct binary downgrade fails closed.

After replacing the database and removing only its generated WAL/SHM companions
with the pre-migration snapshot, the exact previous binary reopened schema 9,
retained its one Archive record, and returned `quick_check=ok`. Its full
Supervisor reached Profile `ready` and `supervisor_live` using Codex CLI 0.149.1,
then completed bounded drain and exited 0.

This verifies the documented rollback mechanism for the schema-9 predecessor:
restore the prepared snapshot and start the previous immutable release. It does
not claim automatic down migration, cross-platform restore, or restoration of a
live production Profile. The temporary rehearsal configured no provider and sent
no Channel message.
