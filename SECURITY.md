# Security Policy

OpenMacaw is pre-release. This policy defines the expected security reporting
and handling process while the project is being prepared for public
open-source use.

## Reporting vulnerabilities

Do not report security vulnerabilities through public issues.

Use GitHub private vulnerability reporting for this repository if it is
enabled. If private vulnerability reporting is unavailable, contact the
repository owner through GitHub and avoid including exploit details in public
comments.

Please include:

- the affected subsystem: `platform`, `runtime`, `local-runtime-helper`, or
  repository-wide;
- affected versions, commit SHAs, or branches;
- reproduction steps;
- expected and actual impact;
- whether credentials, local files, network access, or agent tool execution are
  involved;
- logs or screenshots with secrets removed.

## Supported versions

OpenMacaw does not yet have stable public releases. Security fixes are expected
to target `main` until a versioned release policy is published.

## Security-sensitive areas

Pay particular attention to changes involving:

- credential storage, resolution, redaction, and logging;
- Supabase service-role access, auth settings, and generated schema artifacts;
- runtime launcher and worker bridge APIs;
- local relay frames and token handling;
- local tool execution, workspace access, and runner configuration;
- scripts that print environment data, logs, support bundles, or diagnostics;
- deployment examples that reference cloud accounts or private infrastructure.

## Secret handling

Never commit real credentials, local `.env` files, credential-bearing URLs,
tokens, private keys, logs containing secrets, or customer/user data.

Use placeholder values in examples. When sharing diagnostic output, redact
values for keys containing terms such as `token`, `secret`, `password`,
`authorization`, `api_key`, `private_key`, `service_role`, or `bearer`.

## Local execution model

The local runtime helper can connect a user's machine to local runners and may
execute configured local workflows. Public docs and code changes should make
the trust boundary explicit: what runs locally, what data is sent to remote
services, which credentials are used, and how users can disable or revoke
access.
