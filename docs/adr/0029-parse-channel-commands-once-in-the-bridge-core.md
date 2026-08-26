# Parse Channel commands once in the Bridge core

Channel adapters forward normalized text to one Bridge Command parser. Only a registered command exactly matching the start of a message is executed; `//text` escapes to ordinary Codex input, and an unknown slash command returns an error and `/help` rather than creating a Turn. Provider-native command menus are optional shortcuts and cannot change command names, argument rules, or authorization. This keeps QQ and WhatsApp control semantics equivalent and prevents adapter-specific parsing from bypassing Profile capabilities.
