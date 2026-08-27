# Thread Binding and Codex input correlation

## Ownership

The Bridge stores only the current mapping from a Channel Conversation scope to
a Codex Thread ID. Codex remains authoritative for the Thread, its Turns,
history, settings, and compaction. The Bridge does not copy any of that content.

The stable App Server contract distinguishes creating a new Thread from loading
an existing one: `thread/start` creates, while `thread/resume` reopens a stored
Thread so later `turn/start` calls append to it. `thread/read` is intentionally
not used as a substitute because it does not load or subscribe the Thread. See
the [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

## Binding key

A Thread Binding is Profile-local and keyed by:

- the account-scoped Conversation Key;
- `conversation` scope by default; or
- `participant` scope plus Provider Identity for configured group isolation.

Private conversations always use conversation scope because their Conversation
Key already contains the provider-stable private-conversation identity. A new
Profile Store records only the Binding ID, key, Codex Thread ID, and binding
time.

## Process generation

`TurnCoordinator` keeps only a generation-local set of loaded Thread IDs. A new
Thread is loaded by its successful `thread/start`. The first use of an existing
Binding in a new App Server process calls `thread/resume`; later Turns in that
same process do not resume it again. A resume response naming a different Thread
fails before `turn/start`.

## Input ordering

For an admitted Channel message, `ConversationTurnCoordinator` uses this order:

1. resolve or create the Thread Binding;
2. start or resume the native Codex Thread;
3. persist `accepted` input correlation with the Archive Record ID and a unique
   `clientUserMessageId`;
4. call native `turn/start`;
5. persist the returned Codex Turn ID as `started`;
6. commit the Logical Result and all Outbox segments;
7. mark the input correlation `terminal`.

If the outcome becomes unclear after acceptance, the correlation becomes
`uncertain`. The Bridge does not automatically replay it. Terminal text is split
on Unicode character boundaries into at most 64 KiB Outbox segments.

The Profile worker now connects normalized Adapter events through the single
Inbound Pipeline, Access Policy, command parser, and Admission Controller before
calling this coordinator. A second ordinary message for the same active Binding
in steer mode uses native `turn/steer` with the exact `threadId` and
`expectedTurnId`. Its accepted correlation is attached to that Turn and reaches
the same terminal status; an unclear steer outcome becomes `uncertain` and is
not replayed automatically.

## Schema

Thread Bindings and Codex input correlations are part of Bridge Profile schema
version 4. Older stores fail closed with `migration_required`; normal service
startup never migrates them.
