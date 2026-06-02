defmodule SymphonyElixir.ToolRegistry.Bundles do
  @moduledoc """
  Named tool bundles exposed by the runtime.
  """

  @spec manager() :: [String.t()]
  def manager, do: names(:manager)

  @spec test() :: [String.t()]
  def test, do: names(:test)

  @spec planner() :: [String.t()]
  def planner, do: names(:planner)

  @spec repo_read() :: [String.t()]
  def repo_read, do: names(:repo_read)

  @spec coding() :: [String.t()]
  def coding, do: names(:coding)

  @doc "Return the registered tool names for a bundle."
  @spec names(atom()) :: [String.t()]
  def names(bundle) when is_atom(bundle) do
    SymphonyElixir.ToolRegistry.bundle(bundle)
  end
end
