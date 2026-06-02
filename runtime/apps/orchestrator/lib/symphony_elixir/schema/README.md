# Runtime Schema Namespace

`SymphonyElixir.Schema` owns validation for JSON payloads that enter the
runtime from another process or persisted file. Boundary modules should decode
JSON, call `SymphonyElixir.Schema.validate/2` with a registered schema type, and
only pass the returned struct into downstream logic.

Each schema module should:

- use an Ecto embedded schema for wire payloads, unless it represents a database
  table;
- expose `validate/1`, returning `{:ok, struct}` or `{:error, Ecto.Changeset.t()}`;
- define a concrete `@type t` for downstream Dialyzer coverage;
- reject malformed fields at the boundary instead of normalizing them into an
  apparently valid value.

Register new wire schema modules in `SymphonyElixir.Schema` so callers use one
dispatcher shape consistently:

```elixir
case SymphonyElixir.Schema.validate(:local_relay_register, payload) do
  {:ok, register} -> handle_register(register)
  {:error, changeset} -> reject_register(changeset)
end
```

The initial `:wire_envelope` type is intentionally minimal. It proves the
dispatcher and changeset error contract before later PRs add concrete schemas
for execution profiles, local-relay registrations, gateway frames, OpenClaw
frames, and launcher state.
