defmodule SymphonyElixir.Tools.Echo do
  @moduledoc """
  Reference tool implementation used to exercise the tool registry contract.
  """

  @behaviour SymphonyElixir.Tool

  @impl true
  def name, do: "echo"

  @impl true
  def description, do: "Echoes the provided arguments and selected context."

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => true,
      "properties" => %{
        "message" => %{"type" => "string"}
      }
    }
  end

  @impl true
  def bundle, do: :test

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context) when is_map(arguments) and is_map(context) do
    {:ok,
     %{
       output: %{
         arguments: arguments,
         context: Map.take(context, [:request_id, "request_id"])
       },
       metadata: %{tool: name()}
     }}
  end
end
