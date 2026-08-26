# Configuration and Supervisor operation

## Configuration source

The current development Supervisor reads one administrator-selected absolute
`config.yaml` path. It never searches the repository, Workspace, current
directory, or Profile directories for configuration or dotenv files.

Use `config.example.yaml` as the non-secret shape reference. Configuration may
contain only Bridge settings and Secret References. Credential values are never
valid configuration fields, and unknown fields fail validation.

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
    stateDirectory: /absolute/path/to/bridge-state
    secretsFile: /absolute/path/to/bridge-state/secrets.env
    channelAccounts:
      qq-primary:
        provider: qq
        enabled: true
        epochId: initial
        appId: env:QQ_BOT_APP_ID
        appSecret: file:/run/secrets/qq-bot-app-secret
    codexExecutable: /optional/absolute/path/to/codex
```

The Profile mapping key is the Profile ID. IDs use lowercase ASCII letters,
digits, and hyphens, start with a letter, and are at most 63 characters.
`workspace`, `codexHome`, and `stateDirectory` must be existing absolute
directories. None of these owned roots may equal, contain, or be contained by
another owned root in the complete candidate. On macOS and Linux,
`stateDirectory` must be a real, service-user-owned directory with mode `0700`;
the Worker creates its `bridge.sqlite` database there with mode `0600`.
`codexExecutable` is optional; when omitted, the Worker resolves `codex` from
its service environment. The Bridge does not install or upgrade it.

`secretsFile` defaults to `stateDirectory/secrets.env`. It must be an explicit
absolute path when overridden; the Bridge never searches for dotenv files.
`channelAccounts` is keyed by a deployment-wide unique Channel Account ID. The
current slice accepts QQ accounts only. Every account has an operator-selected
Epoch ID for durable deduplication. The same Channel Account ID cannot appear
in two Profiles, including when another field in one account is invalid.

`appId` and `appSecret` accept only `env:NAME` or
`file:/absolute/path` Secret References. An `env:` reference resolves first
from the actual service process environment, then from that Profile's
configured `secretsFile`. A `file:` reference reads one secret from one
absolute file. On macOS and Linux, both kinds of files must be regular,
non-symlink files owned by the service user with mode exactly `0600`. Missing,
empty, malformed, or insecure inputs keep the affected adapter unavailable
without revealing a name or value.

The dotenv parser accepts ordinary `KEY=VALUE` records and literal single- or
double-quoted values. It does not execute shell syntax, expand variables,
perform command substitution, or include other files. Do not commit a real
`secrets.env`; ordinary secret-file names and `test-channel.env*` are ignored
by this repository.

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

This variable is for non-secret configuration and Secret References only. A
real credential value still belongs in the process environment, the explicit
Profile `secretsFile`, or an owner-only `file:` target.

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
  --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock
```

The command accepts the validated candidate as the initial Configuration
Revision, starts one Worker child for each enabled Profile, and remains in the
foreground. JSON output reports content-free Profile health and Supervisor
lifecycle events. One unavailable Profile does not make Supervisor liveness
fail or stop healthy siblings.

`SIGINT` and `SIGTERM` trigger the same bounded stop path: Workers receive a
stop request, then the Supervisor uses the configured drain and child-exit
timeouts before forced termination.

## Host-local control plane

The running Supervisor exposes a versioned JSONL administration protocol over
one host-local endpoint. It does not listen on TCP or HTTP. On macOS and Linux,
including Docker, the default endpoint is an owner-only Unix socket below the
platform temporary directory. Its containing directory must be owned by the
service user with mode `0700`, and the socket must be owned by that user with
mode `0600`. A pre-existing active endpoint is never replaced.

Pass the same explicit endpoint to the Supervisor and CLI, or set
`BRIDGE_CONTROL_ENDPOINT` in both process environments:

```sh
node packages/cli/dist/main.js status \
  --endpoint /absolute/path/control.sock
```

The current Node.js runtime does not expose Unix peer credentials. This slice
therefore treats successful access through the verified owner-only directory
and socket as the local System Administrator identity, while still running the
authorization hook for every request. Native peer-credential verification is
a remaining platform edge before release. A Windows named-pipe endpoint shape
exists, but strict ACL provisioning and verification have not yet been tested
on Windows and are not claimed complete.

## Explicit runtime configuration apply

Runtime configuration changes use two CLI invocations. The first rereads the
candidate inside the running Supervisor process, applies its environment, and
returns a redacted transition plan without changing runtime state:

```sh
node packages/cli/dist/main.js config apply \
  --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock
```

Copy the complete `confirmationRequired` revision into a second invocation:

```sh
node packages/cli/dist/main.js config apply \
  --config /absolute/path/config.yaml \
  --confirm FULL_CANDIDATE_REVISION \
  --endpoint /absolute/path/control.sock
```

The second invocation rereads and validates the entire candidate, rejects a
different revision, and sends a short-lived single-use plan token plus the full
revision to the Supervisor. A stale plan is rejected if another Configuration
Revision was accepted in the meantime. After acceptance, affected Profiles
transition independently; changing `stateDirectory`, `secretsFile`, or any
Channel Account restarts only that Profile, while an unchanged Profile is not
restarted. Plan and apply output never includes resolved Secret names or
values.

The process never watches `config.yaml`, treats SIGHUP as reload, or accepts a
direct second-process mutation of Supervisor state.
