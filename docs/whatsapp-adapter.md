# WhatsApp adapter baseline

## Pinned provider library

The first implementation slice pins `baileys@7.0.0-rc14`, published from the
official `WhiskeySockets/Baileys` repository under the MIT License. The package
requires Node.js 20 or newer; the Bridge already requires Node.js 22 or newer.

The adapter follows the pinned source contract:

- one `makeWASocket` instance belongs to one Channel Account adapter;
- live messages arrive through `messages.upsert`;
- rotating credentials are saved after `creds.update`;
- readiness follows `connection.update`;
- unexpected retryable closes replace the Socket using bounded delays of one,
  two, and five seconds with bounded jitter;
- text delivery uses `sendMessage(jid, { text })` and requires the returned
  provider message ID.

History sync is disabled. The adapter accepts only `messages.upsert` events of
type `notify` and drops events carrying `requestId`, matching the upstream
mitigation for placeholder-resend spoofing fixed in recent Baileys releases.
It also ignores own messages, status/broadcast/newsletter JIDs, and provider
events without the identities needed for durable deduplication.

## Channel-neutral projection

Private and group messages become the same `ProviderInboundEvent` used by QQ.
WhatsApp JIDs remain provider-owned identities. Device suffixes are normalized;
group conversation JIDs remain distinct from participant JIDs. Group messages
are active only when Baileys context identifies a mention of the connected
account; other group messages are archived as passive observations.

Outbound text uses the existing `ChannelTextDelivery` contract. When an inbound
text message is the delivery anchor, the Inbound Pipeline carries its provider
message ID, participant identity, and bounded original text through the
transactional Outbox. After restart the adapter reconstructs the pinned
Baileys `quoted` input without persisting a Baileys runtime object. A response with
no provider message ID and every thrown send error are treated as ambiguous,
because the Web protocol does not provide the Bridge an idempotent send key or
a definitive reconciliation lookup. Retry therefore retains the documented
small duplicate window.

## Authentication state

The Bridge does not use Baileys's example `useMultiFileAuthState`, which its own
source does not recommend for production. `openBaileysAuthState` stores rotating
credentials and Signal keys below the fixed Profile path
`stateDirectory/channel-auth/CHANNEL_ACCOUNT_ID`.

On macOS and Linux, the directory must be a real service-user-owned directory
with mode `0700`; every state file must be regular, non-symlink, owner-only
`0600`, and bounded to 16 MiB. Writes use a same-directory exclusive temporary
file, flush, atomic rename, and directory flush. Signal-key writes are serialized
per file. Clearing is rejected by this runtime API and remains reserved for the
explicit logout/revoke workflow.

The account directory is a Generation Store. Each Generation is an owner-only
directory containing one complete Baileys state. The normal Profile worker
opens only the Generation selected by the owner-only `active-generation.json`
marker. It never creates a pairing state, displays a QR, or copies auth between
Profiles. Replacing that small marker atomically activates a registered staged
Generation without mutating the previous active state.

`pairWhatsAppAccount` implements the provider-facing pairing transaction. It
creates a separate staged Generation, projects short-lived QR material only to
the caller-supplied presentation callback, persists rotating credentials,
handles a bounded `restartRequired` sequence, and requires a connected Socket
to prove its normalized Provider Identity. Reauthentication must match the
expected identity; mismatch, timeout, cancellation, presentation failure, or
connection failure preserves the old Active Marker and removes the staged
Generation. Raw QR and Provider Identity values are sensitive and are never
logged or written to Audit or Message Archive by this module.

## Host-local lifecycle control

`WhatsAppChannelAccount` is the deep lifecycle boundary above the inner
adapter. The Profile Worker first proves that the selected account has no
active or queued input, pending Approval Request, or pending, leased, or
retry-wait Outbox record. It then records a body-free `started` Audit Record and
executes one typed action: connect, disconnect, pair, logout, or forget-local.

Pairing uses the staged transaction and replaces only this account's inner
adapter. Its expiring QR event follows the correlated Worker IPC request and the
same Unix-socket JSONL connection to the initiating interactive CLI. The CLI
renders a scannable QR without printing the raw value. Disconnect preserves the
binding and auth state.

The pinned Baileys `logout()` implementation sends a
`remove-companion-device` node but exposes no separate remote-confirmation
receipt. A successful call is therefore recorded as `logout_uncertain`, the
adapter remains stopped, and ordinary reconnect is blocked by an owner-only
revocation marker. `forget-local` is allowed only in that uncertain state and
requires the complete Channel Account ID; it atomically removes only the local
Baileys account root and explicitly does not prove remote invalidation.

```sh
bridge whatsapp pair --profile PROFILE --account ACCOUNT
bridge channel disconnect --profile PROFILE --account ACCOUNT
bridge channel connect --profile PROFILE --account ACCOUNT
bridge whatsapp logout --profile PROFILE --account ACCOUNT
bridge whatsapp forget-local --profile PROFILE --account ACCOUNT --confirm ACCOUNT
```

## Reconnect supervision

An unexpected retryable close discards the old Socket and creates a new one for
the same Channel Account after bounded delay. Only events from the current
Socket generation are accepted, so late events from a replaced Socket cannot
enter the Inbound Pipeline. A successful open resets the attempt budget.

The default budget is three attempts with one-, two-, and five-second delays
and bounded jitter. Baileys `restartRequired` consumes the same finite budget
but reconnects immediately. `loggedOut`, `badSession`, `connectionReplaced`,
`multideviceMismatch`, and `forbidden` are fail-closed administrative states
and do not reconnect automatically. Exhaustion leaves only this adapter
degraded; it does not stop the Profile App Server or sibling adapters. An
intentional stop cancels a pending retry and stale Socket callbacks are ignored.
The Channel-neutral readiness subscription projects disconnect, recovery, and
exhaustion into Profile Health, so the Supervisor observes `degraded` and the
later return to `ready` without treating the Worker as failed.

## Current limits

- Pairing, single-adapter replacement, disconnect, logout uncertainty,
  forget-local, and durable text quotes are implemented. No real WhatsApp
  account is paired by repository acceptance tests.
- Media decryption and bounded content-addressed mirroring remain in the
  Archive/media stage. Receipts beyond send acceptance remain future work.
- The pinned Baileys declaration bundle contains upstream NodeNext declaration
  defects. Only this package enables `skipLibCheck`; its public declarations use
  Bridge-owned structural types so the exception does not propagate to other
  packages. Remove the exception once the pinned dependency publishes clean
  declarations.
