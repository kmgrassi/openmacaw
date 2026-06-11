defmodule SymphonyElixir.Attention do
  @moduledoc """
  Placeholder attention escalation surface for runtime decisions that need a human.
  """

  alias SymphonyElixir.RuntimeLog

  @spec escalate(atom(), term(), map()) :: {:error, {:fatal, {atom(), term()}}}
  def escalate(reason, decision, context) when is_atom(reason) and is_map(context) do
    RuntimeLog.log(:warning, :attention_required, %{
      reason: reason,
      workspace_id: Map.get(context, :workspace_id),
      agent_id: Map.get(context, :agent_id),
      run_id: Map.get(context, :run_id),
      trace_id: Map.get(context, :trace_id),
      decision: decision_payload(decision)
    })

    {:error, {:fatal, {reason, decision}}}
  end

  defp decision_payload(%{__struct__: _struct} = decision), do: Map.from_struct(decision)
  defp decision_payload(decision), do: decision
end
