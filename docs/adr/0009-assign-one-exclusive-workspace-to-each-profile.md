# Assign one exclusive Workspace to each Profile

Each Profile owns exactly one Workspace, and different Profiles cannot access one another's Workspace through Bridge configuration by default. This trades flexible per-conversation project switching for a simpler isolation and routing model: Channel Conversations inherit their Profile's Workspace and cannot submit arbitrary filesystem paths.
