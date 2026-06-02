defmodule SymphonyElixir.Config.ErrorsTest do
  use ExUnit.Case, async: true

  import Ecto.Changeset

  alias SymphonyElixir.Config.{Errors, Schema}

  defmodule SampleConfig do
    use Ecto.Schema

    embedded_schema do
      field(:count, :integer)

      embeds_one(:nested, Nested, on_replace: :update) do
        field(:mode, :string)
      end
    end

    def changeset(attrs) do
      %__MODULE__{}
      |> cast(attrs, [:count])
      |> validate_number(:count, greater_than: 0)
      |> cast_embed(:nested, required: true, with: &nested_changeset/2)
    end

    defp nested_changeset(schema, attrs) do
      schema
      |> cast(attrs, [:mode])
      |> validate_inclusion(:mode, [:strict, :relaxed])
    end
  end

  test "formats nested changeset errors with dotted paths" do
    changeset = SampleConfig.changeset(%{"count" => 0, "nested" => %{"mode" => "invalid"}})

    assert Errors.format(changeset) ==
             "count must be greater than 0, nested.mode is invalid"
  end

  test "schema parse uses extracted formatter" do
    assert {:error, {:invalid_workflow_config, message}} =
             Schema.parse(%{
               "codex" => %{"turn_timeout_ms" => 0},
               "server" => %{"port" => -1}
             })

    parts = String.split(message, ", ") |> Enum.sort()

    assert parts == [
             "codex.turn_timeout_ms must be greater than 0",
             "server.port must be greater than or equal to 0"
           ]
  end
end
