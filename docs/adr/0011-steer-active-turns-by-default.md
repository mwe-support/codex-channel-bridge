# Steer active Turns by default

When a Channel Conversation already has an active Codex Turn, a new ordinary message will default to `turn/steer` rather than silently interrupting the Turn or starting a competing Turn. Profiles may select queue mode instead; if a steer cannot be applied to the exact active Thread and Turn, the message must remain queued with visible status rather than being reinterpreted as an unrelated new Turn.
