# Use separate Codex authentication per Profile

Every Profile will own a separate Codex authentication directory and App Server process. A deployer may independently authorize Profiles against the same upstream subscription, but the Bridge will not copy or silently share login state between Profiles, preserving explicit credential ownership and independent revocation.
