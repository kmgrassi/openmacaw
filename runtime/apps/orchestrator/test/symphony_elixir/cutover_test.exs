defmodule SymphonyElixir.CutoverTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.Cutover
  alias SymphonyElixir.Cutover.Decision

  defmodule AuditStub do
    def write_best_effort(%Decision{} = decision, _opts) do
      send(self(), {:audit, decision})
      :ok
    end
  end

  @profile %{
    "workspaceId" => "workspace-1",
    "agentId" => "agent-1",
    "provider" => "anthropic",
    "model" => "claude-opus-4-7",
    "credentialRef" => %{"id" => "credential-primary"},
    "fallbacks" => [
      %{
        "provider" => "openai",
        "model" => "gpt-4.1",
        "credentialRef" => %{"id" => "credential-fallback"}
      }
    ]
  }

  test "successful fallback writes fallback_succeeded audit row" do
    result =
      Cutover.walk(
        @profile,
        %{"workItemId" => "work-item-1"},
        fn
          %{position: 0} ->
            {:error, %{error_code: "provider_rate_limited", status_code: 429, retryable: true}}

          %{position: 1} ->
            {:ok, %{message: "ok"}}
        end,
        audit_module: AuditStub
      )

    assert {:ok, %{message: "ok"}, %Decision{outcome: :fallback_succeeded}} = result

    assert_received {:audit,
                     %Decision{
                       workspace_id: "workspace-1",
                       agent_id: "agent-1",
                       work_item_id: "work-item-1",
                       from_provider: "anthropic",
                       from_model: "claude-opus-4-7",
                       from_credential_id: "credential-primary",
                       to_provider: "openai",
                       to_model: "gpt-4.1",
                       to_credential_id: "credential-fallback",
                       trigger_error_code: "provider_rate_limited",
                       trigger_status_code: 429,
                       outcome: :fallback_succeeded
                     }}
  end

  test "adapter-missing link writes skipped_no_adapter audit row and continues walking" do
    profile =
      put_in(@profile, ["fallbacks"], [
        %{"provider" => "computer_use", "model" => "browser", "adapterAvailable" => false},
        %{
          "provider" => "openai",
          "model" => "gpt-4.1",
          "credentialRef" => %{"id" => "credential-fallback"}
        }
      ])

    result =
      Cutover.walk(
        profile,
        %{"workItemId" => "work-item-1"},
        fn
          %{position: 0} ->
            {:error, %{error_code: "provider_overloaded", retryable: true}}

          _link ->
            {:ok, %{message: "recovered"}}
        end,
        audit_module: AuditStub
      )

    assert {:ok, %{message: "recovered"}, %Decision{outcome: :fallback_succeeded}} = result

    assert_received {:audit,
                     %Decision{
                       to_provider: "computer_use",
                       to_model: "browser",
                       trigger_error_code: "provider_adapter_missing",
                       outcome: :skipped_no_adapter
                     }}

    assert_received {:audit,
                     %Decision{
                       to_provider: "openai",
                       to_model: "gpt-4.1",
                       trigger_error_code: "provider_overloaded",
                       outcome: :fallback_succeeded
                     }}
  end

  test "exhausted retryable chain writes escalated_exhausted audit row" do
    result =
      Cutover.walk(
        @profile,
        %{"workItemId" => "work-item-1"},
        fn link ->
          {:error,
           %{
             error_code: if(link.position == 0, do: "provider_rate_limited", else: "provider_timeout"),
             status_code: if(link.position == 0, do: 429, else: 408),
             retryable: true
           }}
        end,
        audit_module: AuditStub
      )

    assert {:error, :exhausted, %Decision{outcome: :escalated_exhausted}} = result

    assert_received {:audit,
                     %Decision{
                       to_provider: "openai",
                       to_model: "gpt-4.1",
                       trigger_error_code: "provider_rate_limited",
                       trigger_status_code: 429,
                       outcome: :escalated_exhausted
                     }}
  end
end
