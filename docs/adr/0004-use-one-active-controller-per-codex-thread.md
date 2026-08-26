# Use one active controller per Codex Thread

Bridge-created Codex Threads are the primary external-channel workflow, and a Channel Conversation may later bind explicitly to an existing Codex Thread. Only one Thread Controller may start, steer, or interrupt that Thread at a time; `/attach` grants the Bridge a Control Lease that lasts until `/detach` or administrative revocation. Codex Desktop and the Bridge will not write concurrently because app-server connection ownership, approvals, event delivery, and recovery become ambiguous under competing controllers.
