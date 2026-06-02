# Installing local-runtime-helper

`local-runtime-helper` is a small daemon that connects this machine to the
Harper cloud relay over outbound WSS. It lets Harper dispatch work to local
tools such as OpenAI-compatible model servers and OpenClaw without opening
inbound ports on the user's network.

## Install From Release

Use the release installer to download the matching binary for macOS or Linux
into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/kmgrassi/local-runtime-helper/main/install.sh | sh
```

The installer detects macOS/Linux and arm64/amd64, downloads the matching
release archive, verifies it against the release's `checksums.txt`, and writes
the binary to `~/.local/bin/local-runtime-helper`.

For a tagged release, pin both the script and downloaded archive to the same
tag:

```sh
curl -fsSL https://raw.githubusercontent.com/kmgrassi/local-runtime-helper/v0.1.0/install.sh | LOCAL_RUNTIME_HELPER_VERSION=v0.1.0 sh
```

If `~/.local/bin` is not on your `PATH`, either add it to your shell profile or
run the installed binary by absolute path.

## Manual Install

Download the archive for your platform plus `checksums.txt` from the GitHub
release, verify the archive, then install the binary somewhere on your `PATH`:

```sh
grep '  local-runtime-helper_darwin_arm64.tar.gz$' checksums.txt | shasum -a 256 -c -
tar -xzf local-runtime-helper_darwin_arm64.tar.gz
install -m 0755 local-runtime-helper ~/.local/bin/local-runtime-helper
local-runtime-helper version
```

Linux and Intel macOS builds follow the same pattern with the matching release
archive.

## Configure

Registering this machine will eventually be handled by:

```sh
local-runtime-helper register --workspace=<workspace-id> --token=<one-time-token>
```

Until that command is wired to the cloud registration API, create
`~/.config/harper/runtime.toml` from `docs/runtime.toml.example` and keep it
readable only by your user:

```sh
mkdir -p ~/.config/harper
cp docs/runtime.toml.example ~/.config/harper/runtime.toml
chmod 0600 ~/.config/harper/runtime.toml
```

Set `[cloud].endpoint` to the Harper relay WSS endpoint and `[cloud].token` to
the local runtime token issued from the dashboard. Do not commit this file.

For Ollama, LM Studio, vLLM, or another OpenAI-compatible local server, configure
the runner table like this:

```toml
[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
api_key = "ollama"
model = "qwen2.5-coder:latest"
```

## Check Setup

Use `status` for a non-network summary:

```sh
local-runtime-helper status
```

Use `doctor` before starting the daemon:

```sh
local-runtime-helper doctor
```

`doctor` checks that the config can be read, required fields are present, the
cloud relay host accepts TCP connections, runner endpoints are reachable, and an
OpenAI-compatible runner responds to `/v1/models` when configured.

## Start Manually

```sh
local-runtime-helper start
```

The relay loop is still scaffolded, so current builds report that `start` is not
yet implemented. The install and diagnostics commands are available now so a
fresh machine can be prepared before the relay implementation lands.

## Run With launchd On macOS

Copy the launchd template and replace `__USER__` plus the binary path if needed:

```sh
mkdir -p ~/Library/LaunchAgents
sed "s/__USER__/$USER/g" docs/launchd/com.harper.local-runtime-helper.plist \
  > ~/Library/LaunchAgents/com.harper.local-runtime-helper.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.harper.local-runtime-helper.plist
launchctl enable "gui/$(id -u)/com.harper.local-runtime-helper"
launchctl kickstart -k "gui/$(id -u)/com.harper.local-runtime-helper"
```

Inspect service state with:

```sh
launchctl print "gui/$(id -u)/com.harper.local-runtime-helper"
```

Stop and remove it with:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.harper.local-runtime-helper.plist
rm ~/Library/LaunchAgents/com.harper.local-runtime-helper.plist
```

## Logout And Token Revocation

```sh
local-runtime-helper logout
```

This prints the local config path and the revoke steps. Revoke the machine's
local runtime token from the Harper dashboard, then remove or replace the token
in `~/.config/harper/runtime.toml`. Local file cleanup is not enough by itself;
cloud-side revocation is what prevents future relay connections with that token.
