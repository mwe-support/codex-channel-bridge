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
  codexRestartCooldownMs: 30000

profiles:
  primary:
    enabled: true
    workspace: /absolute/path/to/workspace
    codexHome: /absolute/path/to/codex-home
    stateDirectory: /absolute/path/to/bridge-state
    secretsFile: /absolute/path/to/bridge-state/secrets.env
    admission:
      mode: steer
      maximumActiveTurns: 1
      queueCapacity: 16
      maximumQueueAgeMs: 300000
      accountRateLimit: 30
      accountRateWindowMs: 60000
    approval:
      timeoutMs: 300000
      detail: minimal
    media:
      perAttachmentLimitBytes: 67108864
      profileQuotaBytes: 10737418240
    channelAccounts:
      qq-primary:
        provider: qq
        enabled: true
        epochId: initial
        appId: env:QQ_BOT_APP_ID
        appSecret: file:/run/secrets/qq-bot-app-secret
        groupThreadScope: conversation
        accessPolicy:
          privateChats:
            mode: allowlist
            allow: [provider-private-identity]
          groupChats:
            mode: allowlist
            allow: [provider-group-conversation-id]
          groupParticipants:
            mode: allowlist
            allow: [provider-group-participant-id]
    codexExecutable: /optional/absolute/path/to/codex
```

`codexRestartCooldownMs` is the configured Profile-local circuit-breaker
cooldown after a bounded App Server restart budget is exhausted. Every new
generation repeats the full capability probe before it can become ready.

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
One Secret File cannot be shared by Profiles or overlap another Profile's
Workspace, Codex home, or state boundary.
`channelAccounts` is keyed by a deployment-wide unique Channel Account ID. The
current slice accepts QQ and WhatsApp accounts. Every account has an
operator-selected Epoch ID for durable deduplication. The same Channel Account
ID cannot appear in two Profiles, including when another field in one account
is invalid. WhatsApp rotating authentication is loaded only from the fixed
Profile-local path `stateDirectory/channel-auth/CHANNEL_ACCOUNT_ID`; it is not a
Secret Reference and is never placed in `config.yaml`.

`appId` and `appSecret` accept only `env:NAME` or
`file:/absolute/path` Secret References. An `env:` reference resolves first
from the actual service process environment, then from that Profile's
configured `secretsFile`. A `file:` reference reads one secret from one
absolute file. On macOS and Linux, both kinds of files must be regular,
non-symlink files owned by the service user with mode exactly `0600`. Missing,
empty, malformed, or insecure inputs keep the affected adapter unavailable
without revealing a name or value.

`accessPolicy` fails closed. Its three independent rules default to `deny` and
accept `deny`, `allowlist`, or `open`. Private-chat rules compare the stable
Provider Identity. Group events must pass both the group-conversation rule,
using the provider conversation ID, and the group-participant rule, using the
Provider Identity. An `allowlist` must contain at least one exact identifier;
`deny` and `open` must not contain an `allow` list. `groupThreadScope` defaults
to `conversation`; `participant` gives each admitted group participant a
separate Codex Thread Binding.

Profile-local `admission` defaults to steer mode with one active Turn, a
16-entry queue limit, five-minute maximum queue age, and 30 ordinary inputs per
Channel Account per 60 seconds. The queue is used only when `mode: queue`.
Limits are checked after Access Policy and command parsing and before native
Codex work. See [`admission.md`](admission.md) for runtime semantics.

Profile-local `approval` defaults to a five-minute response window and
`minimal` presentation. `detail` accepts `minimal`, `summary`, or `detailed`.
Minimal mode exposes only the native operation class and an opaque response
token. Summary may include a bounded reason and command summary; detailed may
also include bounded native command, working-directory, or requested-write-root
fields when Codex supplies them. The Bridge never sends the process-scoped
JSON-RPC request ID to the Channel. See [`approval-routing.md`](approval-routing.md).

Profile-local `media` defaults to 64 MiB per attachment and 10 GiB of mirrored
bytes for the Profile. Set `perAttachmentLimitBytes` and `profileQuotaBytes` as
positive integers; the Profile quota must be at least the per-attachment
limit. These limits bound only mirrored bytes. Attachment metadata remains in
the Message Archive when bytes exceed a limit or cannot be fetched.

The dotenv parser accepts ordinary `KEY=VALUE` records and literal single- or
double-quoted values. It does not execute shell syntax, expand variables,
perform command substitution, or include other files. Do not commit a real
`secrets.env`; ordinary secret-file names and `test-channel.env*` are ignored
by this repository.

Removing a Profile or setting `enabled: false` stops its Worker. It does not
delete its Workspace, Codex home, Bridge data, or future Channel authentication
state. Permanent purge remains a separate, explicitly confirmed host-local
operation.

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

### WhatsApp account lifecycle

The same owner-only endpoint carries a closed set of typed WhatsApp lifecycle
operations. Every operation names one Profile and one exclusively bound Channel
Account. Pairing requires an interactive TTY; its raw expiring QR value exists
only on that request connection and is rendered locally. Lifecycle changes fail
while the account has active or queued work, pending Approval Requests, or
pending Outbox delivery.

```sh
bridge whatsapp pair --profile alpha --account wa-primary
bridge channel disconnect --profile alpha --account wa-primary
bridge channel connect --profile alpha --account wa-primary
bridge whatsapp logout --profile alpha --account wa-primary
bridge whatsapp forget-local \
  --profile alpha --account wa-primary --confirm wa-primary
```

`disconnect` is reversible. The pinned provider API cannot confirm remote
logout independently, so `logout` returns `logout_uncertain`, stops automatic
reconnect, and preserves local state. `forget-local` is available only after
that outcome, requires the complete account ID, and does not claim remote
invalidation. Each attempt writes body-free Profile-local Audit Records.

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
