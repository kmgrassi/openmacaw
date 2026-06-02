defmodule SymphonyElixir.Schema.Agent do
  @moduledoc """
  Ecto schema for the Supabase `agent` table.

  Minimal on purpose — only the columns needed to prove the direct Postgres
  connection and typed-query layer work end-to-end. Additional columns will be
  added as callers migrate off the handwritten PostgREST adapter.
  """

  use Ecto.Schema

  @primary_key {:id, :binary_id, autogenerate: false}

  schema "agent" do
    field(:name, :string)
    field(:slug, :string)
    field(:workspace_id, :binary_id)
    field(:status, :string)
  end
end
