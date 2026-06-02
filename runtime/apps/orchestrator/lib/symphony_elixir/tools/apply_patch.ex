defmodule SymphonyElixir.Tools.ApplyPatch do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.LocalModelCoding.PatchExecutor

  @impl true
  def name, do: "apply_patch"

  @impl true
  def description, do: "Apply a structured patch inside the assigned workspace."

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["patch"],
      "properties" => %{
        "patch" => %{"type" => "string"}
      }
    }
  end

  @impl true
  def bundle, do: :coding

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, %{workspace_root: workspace_root} = context) when is_map(arguments) do
    with {:ok, result} <-
           PatchExecutor.execute(arguments,
             workspace_root: workspace_root,
             on_event: Map.get(context, :on_event) || Map.get(context, "on_event") || fn _event -> :ok end
           ) do
      {:ok, %{output: result}}
    end
  end

  def execute(_arguments, _context), do: {:error, :invalid_local_model_coding_context}
end
