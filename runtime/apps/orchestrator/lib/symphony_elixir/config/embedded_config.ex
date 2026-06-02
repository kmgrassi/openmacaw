defmodule SymphonyElixir.Config.EmbeddedConfig do
  @moduledoc false

  defmacro __using__(_opts) do
    quote do
      use Ecto.Schema

      import Ecto.Changeset
      import SymphonyElixir.Config.EmbeddedConfig, only: [cast_with: 3]

      @primary_key false
    end
  end

  @spec cast_with(Ecto.Schema.t(), map(), [atom()]) :: Ecto.Changeset.t()
  def cast_with(schema, attrs, fields) do
    Ecto.Changeset.cast(schema, attrs, fields, empty_values: [])
  end
end
