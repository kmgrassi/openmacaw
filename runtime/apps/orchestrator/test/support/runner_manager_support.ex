defmodule SymphonyElixir.Runner.ManagerTestSupport do
  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.ToolRegistry

  defmacro __using__(opts \\ []) do
    quote do
      use SymphonyElixir.TestSupport, unquote(opts)

      alias SymphonyElixir.Manager.ModelClient
      alias SymphonyElixir.Runner.LlmToolRunner, as: Manager
      alias SymphonyElixir.WorkItem

      import SymphonyElixir.Runner.ManagerTestSupport

      setup do
        SymphonyElixir.Runner.ManagerTestSupport.setup_manager_runner_test(__MODULE__)
      end
    end
  end

  def setup_manager_runner_test(stub_module) do
    Registry.reset!()

    Application.put_env(:symphony_elixir, :manager_responses_req_options, plug: {Req.Test, stub_module})
    Application.put_env(:symphony_elixir, :manager_openai_compatible_req_options, plug: {Req.Test, stub_module})
    Application.put_env(:symphony_elixir, :manager_tools_req_options, plug: {Req.Test, stub_module})

    Application.put_env(:symphony_elixir, :manager_tools,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    ExUnit.Callbacks.on_exit(fn ->
      Application.delete_env(:symphony_elixir, :manager_responses_req_options)
      Application.delete_env(:symphony_elixir, :manager_openai_compatible_req_options)
      Application.delete_env(:symphony_elixir, :manager_tools_req_options)
      Application.delete_env(:symphony_elixir, :manager_tools)
      Registry.reset!()
    end)

    :ok
  end

  def tool_names, do: ToolRegistry.bundle(:manager)

  def start_manager_relay_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:relay_dispatch, frame})

          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "tool_calls" => [
              %{
                "id" => "call-1",
                "name" => "snooze",
                "arguments" => %{"work_item_id" => "work-1", "seconds" => 300}
              }
            ]
          })

          receive do
            {:local_relay_frame, continuation} ->
              send(parent, {:relay_continuation, continuation})

              Registry.complete(correlation_id, %{
                "output_text" => "Snoozed from relay.",
                "usage" => %{"total_tokens" => 9}
              })
          end
      end
    end)
  end

  def start_disconnect_before_continuation_helper(parent) do
    spawn(fn ->
      receive do
        {:local_relay_dispatch,
         %{
           "correlation_id" => correlation_id,
           "workspace_id" => workspace_id
         }} ->
          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "tool_calls" => [
              %{
                "id" => "call-1",
                "name" => "snooze",
                "arguments" => %{"work_item_id" => "work-1", "seconds" => 300}
              }
            ]
          })

          Registry.unregister(workspace_id, "machine-1")
          send(parent, {:relay_disconnected_before_continuation, correlation_id})
      end
    end)
  end

  def configure_history_adapter(rows, display_names \\ %{}) do
    Application.put_env(
      :symphony_elixir,
      :message_log_adapter,
      SymphonyElixir.Runner.ManagerTestSupport.HistoryStubAdapter
    )

    ExUnit.Callbacks.on_exit(fn -> Application.delete_env(:symphony_elixir, :message_log_adapter) end)
    Process.put(:history_rows, rows)
    Process.put(:history_display_names, display_names)
  end

  defmodule HistoryStubAdapter do
    def list_agent_messages(_agent_id, _opts) do
      case Process.get(:history_rows) do
        nil -> {:ok, [], %{}}
        rows -> {:ok, rows, %{}}
      end
    end

    def resolve_user_display_names(_user_ids) do
      {:ok, Process.get(:history_display_names, %{})}
    end
  end
end
