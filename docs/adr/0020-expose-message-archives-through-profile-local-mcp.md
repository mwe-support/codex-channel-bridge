# Expose Message Archives through Profile-local MCP

Each Profile will expose its own Message Archive to Codex through a local, access-constrained MCP server. Codex decides when to call archive search and retrieval tools through its native MCP and tool lifecycle; the Bridge will not implement a parallel tool runtime or inject an unbounded hybrid-search result into every Turn. Archive tools may only address records owned by the current Profile, and automatic Context Projection remains separately bounded.
