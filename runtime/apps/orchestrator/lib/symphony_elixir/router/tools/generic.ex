defmodule SymphonyElixir.Router.Tools.Generic do
  @moduledoc false

  defmacro __using__(tool_name: tool_name) do
    quote do
      @behaviour SymphonyElixir.Tool

      alias SymphonyElixir.Router.Tools

      @tool_name unquote(tool_name)

      @impl true
      def name, do: @tool_name

      @impl true
      def description, do: Tools.tool_spec(@tool_name)["description"]

      @impl true
      def parameters_schema, do: Tools.tool_spec(@tool_name)["inputSchema"]

      @impl true
      def bundle, do: [:router]

      @impl true
      def execution_kind, do: :helper

      @impl true
      def execute(_arguments, _context), do: {:error, :platform_database_tool}
    end
  end
end
