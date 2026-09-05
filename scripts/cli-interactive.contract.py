#!/usr/bin/env python3
"""Unix PTY acceptance for setup and hidden secret entry; no live Channel access."""
import json
import os
import pathlib
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
CODEX = shutil.which("codex")
if not NODE or not CODEX:
    raise SystemExit("Administrator-supplied Node and Codex executables are required")


def setup(root, mode, cancel=False, service_cancel=False):
    directory = root / mode
    config = directory / "config.yaml"
    master, slave = pty.openpty()
    process = subprocess.Popen([NODE, str(REPO / "packages/cli/dist/main.js"), "setup", mode,
                                "--config", str(config)], stdin=slave, stdout=slave, stderr=slave,
                               env={**os.environ, "XDG_DATA_HOME": str(root / "data")}, cwd=REPO)
    os.close(slave)
    output = b""
    pending = b""
    secret_index = 0
    markers = ["SYNTHETIC-PTY-ID-NOECHO", "SYNTHETIC-PTY-SECRET-NOECHO"]
    deadline = time.monotonic() + 60
    try:
        while process.poll() is None:
            if time.monotonic() >= deadline:
                raise AssertionError("Interactive setup hung")
            if not select.select([master], [], [], .1)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            output += chunk
            pending += chunk
            visible = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", pending)
            if not visible.endswith(b": "):
                continue
            prompt = visible.decode(errors="replace").splitlines()[-1]
            pending = b""
            answer = ""
            if prompt.startswith("Profile ID"):
                answer = "pty-" + mode
            elif prompt.startswith("Workspace"):
                answer = str(root / "workspace")
            elif prompt.startswith("Codex home"):
                answer = str(root / "codex")
            elif prompt.startswith("Administrator-supplied"):
                answer = CODEX
            elif prompt.startswith("Write this configuration?"):
                answer = "no" if cancel else "yes"
            elif prompt.startswith("Enter QQ secrets now"):
                answer = "yes"
            elif prompt.startswith("Register a system service now"):
                answer = "yes" if service_cancel else "no"
            elif prompt.startswith("Secret (input hidden)"):
                answer = markers[secret_index]
                secret_index += 1
            os.write(master, (answer + "\r").encode())
        assert process.wait(timeout=5) == 0, "Setup did not exit successfully"
        if service_cancel:
            assert b"Start the registered service now" not in output, "Cancelled service installation offered to start a service"
        for marker in markers:
            assert marker.encode() not in re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output), "Secret appeared in terminal output"
        if cancel:
            assert not config.exists(), "Cancelled setup wrote configuration"
        else:
            assert config.exists() and secret_index == 2
            subprocess.run([NODE, str(REPO / "packages/cli/dist/main.js"), "config", "check", "--config", str(config)],
                           check=True, stdout=subprocess.DEVNULL)
            secret = root / "data/codex-channel-bridge/profiles" / ("pty-" + mode) / "state/secrets.env"
            assert secret.stat().st_mode & 0o777 == 0o600
            assert all(marker in secret.read_text() for marker in markers)
        print(json.dumps({"mode": mode, "cancelled": cancel, "exit": 0, "secretEcho": False,
                          "configurationValidated": not cancel, "serviceCancelled": service_cancel}))
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        os.close(master)


with tempfile.TemporaryDirectory(prefix="bridge-cli-pty-") as temporary:
    root = pathlib.Path(temporary).resolve()
    for name in ["workspace", "codex"]:
        (root / name).mkdir(mode=0o700)
    setup(root, "quick")
    setup(root, "full")
    # A separate output root verifies cancellation before any state-directory creation.
    cancel_root = root / "cancel"
    cancel_root.mkdir(mode=0o700)
    for name in ["workspace", "codex"]:
        (cancel_root / name).mkdir(mode=0o700)
    setup(cancel_root, "quick", cancel=True)

    service_root = root / "service-cancel"
    service_root.mkdir(mode=0o700)
    for name in ["workspace", "codex"]:
        (service_root / name).mkdir(mode=0o700)
    setup(service_root, "quick", service_cancel=True)
