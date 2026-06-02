defmodule SymphonyElixir.Planner.DatabaseToolsCase do
  use ExUnit.CaseTemplate

  using do
    quote do
      use ExUnit.Case, async: false

      alias SymphonyElixir.Planner.DatabaseTools

      import SymphonyElixir.Planner.DatabaseToolsCase
    end
  end

  setup %{module: stub_module} do
    SymphonyElixir.TestSupport.put_app_envs(:symphony_elixir,
      planner_database_tools: [
        endpoint: "https://test.supabase.co",
        api_key: "secret"
      ],
      planner_database_tools_req_options: [plug: {Req.Test, stub_module}]
    )

    :ok
  end

  def restore_env(_key, nil), do: :ok
  def restore_env(key, value), do: System.put_env(key, value)
end
