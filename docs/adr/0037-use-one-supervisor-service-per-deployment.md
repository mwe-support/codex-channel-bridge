# Use one Supervisor service per deployment

Each Bridge deployment will register one operating-system Supervisor service, which starts and monitors the configured Profile-worker child processes; each worker in turn supervises its exclusive App Server child. Profiles will not become separate launchd, systemd, Windows, or Docker services, so adding or removing one remains Bridge configuration rather than platform-service administration. The process hierarchy still isolates worker failures: one Profile must not terminate the Supervisor or its siblings.
