# Configuration and Supervisor operation

## Configuration source

The current development Supervisor reads one administrator-selected absolute
`config.yaml` path. It never searches the repository, Workspace, current
directory, or Profile directories for configuration or dotenv files.

Use `config.example.yaml` as the non-secret shape reference. Configuration may
contain only Bridge settings. Credentials and Secret Reference fields are not
part of this slice and unknown fields fail validation.

## Schema

```yaml
schemaVersion: 1

supervisor:
  drainTimeoutMs: 300000
  childExitTimeoutMs: 10000

profiles:
  primary:
    enabled: true
    workspace: /absolute/path/to/workspace
    codexHome: /absolute/path/to/codex-home
    codexExecutable: /optional/absolute/path/to/codex
```

The Profile mapping key is the Profile ID. IDs use lowercase ASCII letters,
digits, and hyphens, start with a letter, and are at most 63 characters.
`workspace` and `codexHome` must be existing absolute directories and must be
exclusive across the complete candidate. `codexExecutable` is optional; when
omitted, the Worker resolves `codex` from its service environment. The Bridge
does not install or upgrade it.

Removing a Profile or setting `enabled: false` stops its Worker. It does not
delete its Workspace, Codex home, Bridge data, or future Channel authentication
state. Permanent purge remains a separate future host-local operation.

## Environment overrides

The process environment overrides YAML through one optional JSON object:

```sh
BRIDGE_CONFIG_OVERRIDES_JSON='{"profiles":{"primary":{"enabled":false}}}'
```

Objects merge recursively by key, so Profile IDs remain stable and no array
index convention is needed. The fully merged candidate is then validated as a
whole. Empty, malformed, unknown, or incomplete override data rejects the
candidate and does not produce a Configuration Revision.

This variable is for non-secret configuration only. Channel credentials will
use the separately specified Secret Reference and Profile `secrets.env`
mechanism when Channel Accounts are implemented.

## Read-only validation

Build the repository, then run:

```sh
node packages/cli/dist/main.js config check \
  --config /absolute/path/config.yaml
```

The command parses YAML without aliases, applies the environment override,
rejects unknown keys, validates all Profile paths, and prints only the revision
plus Profile IDs and enabled state. It does not start, stop, repair, or mutate a
Profile.

## Foreground Supervisor

Start the development Supervisor explicitly:

```sh
node packages/cli/dist/main.js supervisor run \
  --config /absolute/path/config.yaml
```

The command accepts the validated candidate as the initial Configuration
Revision, starts one Worker child for each enabled Profile, and remains in the
foreground. JSON output reports content-free Profile health and Supervisor
lifecycle events. One unavailable Profile does not make Supervisor liveness
fail or stop healthy siblings.

`SIGINT` and `SIGTERM` trigger the same bounded stop path: Workers receive a
stop request, then the Supervisor uses the configured drain and child-exit
timeouts before forced termination.

The first release will expose runtime `config apply` only through the
authenticated host-local administration IPC. That control plane is not part of
this development slice, so `supervisor run` does not watch files, treat SIGHUP
as reload, or offer an unsafe second-process apply workaround.
