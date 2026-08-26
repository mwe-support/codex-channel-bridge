# Support four first-class deployment targets

The first public release will support native macOS, native Linux, native Windows, and Linux Docker deployments rather than treating non-macOS environments as best-effort ports. Platform-specific service management may differ, but the Bridge domain, Profile behavior, Channel contracts, persistence guarantees, and core acceptance tests must remain equivalent across all four targets.
