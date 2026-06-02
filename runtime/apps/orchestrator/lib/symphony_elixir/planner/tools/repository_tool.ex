defmodule SymphonyElixir.Planner.Tools.RepositoryTool do
  @moduledoc false

  defmacro __using__(tool_name: tool_name) do
    quote do
      @behaviour SymphonyElixir.Tool

      alias SymphonyElixir.Planner.RepositoryTools
      alias SymphonyElixir.Planner.Tools.Context
      alias SymphonyElixir.Tools.RepositoryContext

      @tool_name unquote(tool_name)

      @impl true
      def name, do: @tool_name

      @impl true
      def description, do: RepositoryTools.tool_spec(@tool_name)["description"]

      @impl true
      def parameters_schema, do: RepositoryTools.tool_spec(@tool_name)["inputSchema"]

      @impl true
      def bundle do
        if @tool_name in ["repo.list", "repo.read_file", "repo.search"] do
          [:repo_read, :coding]
        else
          :repo_read
        end
      end

      @impl true
      def execution_kind, do: :runtime

      @impl true
      def execute(arguments, %{workspace_root: workspace_root} = context)
          when is_map(arguments) and is_map(context) do
        if Map.has_key?(arguments, "workspace_id") or Map.has_key?(arguments, :workspace_id) do
          RepositoryTools.execute(@tool_name, arguments, Context.to_opts(context))
        else
          with {:ok, repo_args, opts} <- RepositoryContext.repository_arguments(arguments, workspace_root),
               {:ok, result} <-
                 RepositoryTools.execute(@tool_name, repo_args, RepositoryContext.repository_opts(opts, context)) do
            {:ok, %{output: RepositoryContext.normalize_repository_result(@tool_name, result)}}
          end
        end
      end

      def execute(arguments, context) when is_map(arguments) and is_map(context) do
        RepositoryTools.execute(@tool_name, arguments, Context.to_opts(context))
      end
    end
  end
end
