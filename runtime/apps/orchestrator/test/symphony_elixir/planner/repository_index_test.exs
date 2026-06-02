defmodule SymphonyElixir.Planner.RepositoryIndexTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Codex.DynamicTool
  alias SymphonyElixir.Planner.RepositoryIndex

  setup do
    root = Path.join(System.tmp_dir!(), "repository-index-test-#{System.unique_integer([:positive])}")
    workspace = Path.join(root, "workspace-1")
    File.mkdir_p!(Path.join(workspace, "lib/demo"))
    File.mkdir_p!(Path.join(workspace, "lib/demo_web"))
    File.mkdir_p!(Path.join(workspace, "priv/static/js"))
    File.mkdir_p!(Path.join(workspace, "test/demo"))

    File.write!(Path.join(workspace, "lib/demo/planner.ex"), """
    defmodule Demo.Planner do
      def create_plan(args) do
        args
      end

      defp normalize_args(args), do: args
    end
    """)

    File.write!(Path.join(workspace, "lib/demo_web/router.ex"), """
    defmodule DemoWeb.Router do
      scope "/", DemoWeb do
        get "/plans", PlanController, :index
      end
    end
    """)

    File.write!(Path.join(workspace, "test/demo/planner_test.exs"), """
    defmodule Demo.PlannerTest do
      use ExUnit.Case

      test "creates plans" do
        assert true
      end
    end
    """)

    File.mkdir_p!(Path.join(workspace, "node_modules/pkg"))
    File.write!(Path.join(workspace, "node_modules/pkg/ignored.ts"), "export function ignored() {}")
    File.write!(Path.join(workspace, "priv/static/js/app.js"), "export function ignoredStatic() {}")
    File.write!(Path.join(workspace, ".env"), "SECRET=not-indexed")

    on_exit(fn -> File.rm_rf(root) end)

    %{root: root, workspace: workspace}
  end

  test "build extracts definitions, routes, and tests without dependency files", %{workspace: workspace} do
    assert {:ok, index} = RepositoryIndex.build(workspace)
    names = Enum.map(index.symbols, & &1.name)
    paths = Enum.map(index.symbols, & &1.path)

    assert "Demo.Planner" in names
    assert "create_plan" in names
    assert "creates plans" in names
    assert Enum.any?(index.symbols, &(&1.kind == "route" and &1.path == "lib/demo_web/router.ex"))
    refute Enum.any?(paths, &String.starts_with?(&1, "node_modules/"))
    refute "ignoredStatic" in names
    refute Enum.any?(paths, &String.starts_with?(&1, "priv/static/"))
    refute Enum.any?(paths, &(&1 == ".env"))
  end

  test "read_symbols filters by query, kind, path, and limit", %{workspace: workspace} do
    assert {:ok, result} =
             RepositoryIndex.read_symbols(workspace, %{
               "workspace_id" => "workspace-1",
               "path" => "lib/demo",
               "query" => "plan",
               "kinds" => ["module", "function"],
               "limit" => 2
             })

    assert %{"symbols" => symbols, "stats" => %{"files_indexed" => 3}} = result
    assert length(symbols) <= 2
    assert Enum.all?(symbols, &String.starts_with?(&1["path"], "lib/demo"))
    assert Enum.all?(symbols, &(&1["kind"] in ["module", "function"]))
  end

  test "dynamic tool executes repo.read_symbols against the session workspace", %{root: root} do
    response =
      DynamicTool.execute(
        "repo.read_symbols",
        %{"workspace_id" => "workspace-1", "query" => "create_plan"},
        allowed_tools: ["repo.read_symbols"],
        workspace_root: root
      )

    assert response["success"] == true
    assert %{"symbols" => [%{"name" => "create_plan"} | _]} = Jason.decode!(response["output"])
  end

  test "dynamic tool fails normally when workspace scope is missing" do
    response =
      DynamicTool.execute(
        "repo.read_symbols",
        %{"workspace_id" => "workspace-1"},
        allowed_tools: ["repo.read_symbols"]
      )

    assert response["success"] == false
    assert %{"error" => %{"message" => "repo.read_symbols failed.", "reason" => reason}} = Jason.decode!(response["output"])
    assert reason =~ "workspace_not_found"
  end

  test "read_symbols rejects path traversal", %{workspace: workspace} do
    assert {:error, {:invalid_repository_path, "../outside"}} =
             RepositoryIndex.read_symbols(workspace, %{"workspace_id" => "workspace-1", "path" => "../outside"})
  end

  test "get_or_build returns a normal error when the cache server call times out", %{workspace: workspace} do
    server =
      spawn(fn ->
        Process.sleep(:infinity)
      end)

    on_exit(fn -> Process.exit(server, :kill) end)

    assert {:error, :repository_index_timeout} =
             RepositoryIndex.get_or_build(workspace,
               server: server,
               timeout: 1
             )
  end
end
