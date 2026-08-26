# Keep the Supervisor in the foreground

The Bridge Supervisor will remain one foreground process and will not daemonize, fork into the background, write PID files, or restart itself. Platform packaging translates launchd, systemd, Windows Service control, and Docker stop signals into the common bounded drain-and-exit contract, while the platform service manager alone owns Supervisor restart policy. The Supervisor continues to restart Profile workers internally, keeping that child supervision distinct from host-service recovery and avoiding nested restart loops.
