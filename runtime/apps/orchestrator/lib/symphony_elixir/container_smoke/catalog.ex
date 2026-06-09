defmodule SymphonyElixir.ContainerSmoke.Catalog do
  @moduledoc """
  Canonical production container-execution smoke catalog.
  """

  @tests [
    {"task_launch", "Executor task starts, reaches RUNNING, exits successfully, and is observable by Runtime."},
    {"log_split", "Executor non-error logs and error logs land in their configured destinations."},
    {"egress_allow", "Allowed egress destination is reachable from the executor network boundary."},
    {"egress_deny", "Denied egress destination is blocked by the executor network boundary."},
    {"secret_injection", "Allowed Secrets Manager or SSM value is readable only through the configured grant."},
    {"sts_scope_positive", "Scoped run credentials can write and read the current run artifact prefix."},
    {"sts_scope_negative", "Scoped run credentials cannot read or write another run or workspace prefix."},
    {"vpc_endpoint_reachability", "Required AWS VPC endpoints are reachable without public NAT egress."},
    {"queue_round_trip", "Runtime queue/EventBridge round trip delivers a smoke event and receives acknowledgement."},
    {"cancellation", "Runtime cancellation stops the executor task and observes the terminal state."},
    {"end_to_end", "A coding run executes shell.exec and apply_patch, uploads artifacts, and reports completion."}
  ]

  @type smoke_test :: %{required(:id) => String.t(), required(:description) => String.t(), required(:command_env) => String.t()}

  @spec tests() :: [smoke_test()]
  def tests do
    Enum.map(@tests, fn {id, description} ->
      %{
        id: id,
        description: description,
        command_env: "CONTAINER_SMOKE_#{String.upcase(id)}_COMMAND"
      }
    end)
  end

  @spec test_ids() :: [String.t()]
  def test_ids, do: Enum.map(tests(), & &1.id)
end
