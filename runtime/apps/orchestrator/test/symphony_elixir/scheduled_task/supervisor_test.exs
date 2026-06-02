defmodule SymphonyElixir.ScheduledTask.SupervisorTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.ScheduledTask.Supervisor

  setup do
    previous_url = System.get_env("SUPABASE_URL")
    previous_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")

    System.put_env("SUPABASE_URL", "https://test.supabase.co")
    System.put_env("SUPABASE_SERVICE_ROLE_KEY", "test-api-key")

    on_exit(fn ->
      restore_env("SUPABASE_URL", previous_url)
      restore_env("SUPABASE_SERVICE_ROLE_KEY", previous_key)
    end)

    :ok
  end

  test "auto-starts the scheduler when generated schema supports the v1 contract" do
    assert {:ok, pid} = Supervisor.start_link(name: nil)

    assert [
             {SymphonyElixir.ScheduledTask.Scheduler, _pid, :worker, [SymphonyElixir.ScheduledTask.Scheduler]}
           ] = Elixir.Supervisor.which_children(pid)
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)
end
