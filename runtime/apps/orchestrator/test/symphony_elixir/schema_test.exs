defmodule SymphonyElixir.SchemaTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Schema
  alias SymphonyElixir.Schema.WireEnvelope

  describe "validate/2" do
    test "returns a typed struct for a supported schema" do
      assert {:ok, %WireEnvelope{type: "ping"}} =
               Schema.validate(:wire_envelope, %{"type" => "ping"})
    end

    test "returns a changeset with field-level errors for invalid payloads" do
      assert {:error, %Ecto.Changeset{} = changeset} =
               Schema.validate(:wire_envelope, %{})

      assert %{type: ["can't be blank"]} = errors_on(changeset)
    end

    test "rejects unsupported schema types" do
      assert {:error, {:unsupported_schema_type, :unknown}} = Schema.validate(:unknown, %{})
    end

    test "keeps malformed payloads on the supported schema validation path" do
      assert {:error, %Ecto.Changeset{} = changeset} =
               Schema.validate(:wire_envelope, [])

      assert %{type: ["must be provided in an object payload"]} = errors_on(changeset)
    end
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Enum.reduce(opts, message, fn {key, value}, acc ->
        String.replace(acc, "%{#{key}}", to_string(value))
      end)
    end)
  end
end
