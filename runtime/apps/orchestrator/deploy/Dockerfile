FROM hexpm/elixir:1.19.0-erlang-26.2.5.19-ubuntu-jammy-20260217 AS builder

ENV MIX_ENV=prod
ENV ERL_AFLAGS="-kernel shell_history enabled"

WORKDIR /app

RUN mix local.hex --force && \
    mix local.rebar --force

COPY mix.exs mix.lock ./
RUN mix deps.get

COPY . .
RUN mix do deps.get, escript.build

FROM hexpm/elixir:1.19.0-erlang-26.2.5.19-ubuntu-jammy-20260217

WORKDIR /app
RUN useradd --create-home --shell /bin/bash appuser

# DEBIAN_FRONTEND=noninteractive on the install step suppresses the
# tzdata configuration prompt ("Geographic area:") that one of the
# transitively-pulled packages (introduced when git was added in
# #393) triggers in this Ubuntu Jammy base. Without it, the build
# hangs indefinitely on the prompt with no TTY attached — verified
# in the GitHub Actions log of deploy run 26183392350 which timed
# out at exactly that line. Inlined on the install rather than
# setting an ENV so later RUN steps still get the normal frontend.
# Install `gh` (GitHub CLI) and `codex` alongside the other tools the
# orchestrator shells out to. gh is required by the `git.run` tool so
# the Manager Agent (and coding agents) can do PR shepherding; codex is
# required by Codex.AppServer, which spawns the CLI for coding-agent
# sessions.
#
# gh isn't in the default Ubuntu repos; pull it from the official
# cli.github.com apt source. Keyring is added before the apt source so
# apt-get update can verify signatures.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      awscli ca-certificates curl git gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh nodejs && \
    npm install -g @openai/codex@0.133.0 && \
    codex --version && \
    npm cache clean --force && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/bin /app/elixir /tmp/openmacaw && \
    chown -R appuser:appuser /app /tmp/openmacaw

COPY --from=builder --chown=appuser:appuser /app/bin/symphony /app/bin/symphony
COPY --chown=appuser:appuser WORKFLOW.md /app/elixir/WORKFLOW.md

RUN chmod 755 /app/bin/symphony && \
    chmod 644 /app/elixir/WORKFLOW.md

USER appuser

ENV PATH="/app:${PATH}"
EXPOSE 4100

ENTRYPOINT ["/app/bin/symphony"]
CMD ["launcher", "--port", "4100", "--state-dir", "/tmp/openmacaw/launcher", "--workflow", "/app/elixir/WORKFLOW.md"]
