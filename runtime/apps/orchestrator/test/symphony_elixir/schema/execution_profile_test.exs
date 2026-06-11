defmodule SymphonyElixir.Schema.ExecutionProfileTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Schema
  alias SymphonyElixir.Schema.ExecutionProfile

  describe "validate/1" do
    test "returns a typed struct for a valid execution profile" do
      assert {:ok, %ExecutionProfile{} = profile} =
               Schema.validate(:execution_profile, %{
                 "agent_id" => "9bdf2f7a-4103-4c92-ac10-5a86c119f7f0",
                 "runner_kind" => "codex",
                 "provider" => "openai_codex",
                 "model" => "gpt-5.2",
                 "source_metadata" => %{"routing_rule_id" => "route-1"}
               })

      assert profile.runner_kind == "codex"
      assert profile.provider == "openai_codex"
      assert profile.model == "gpt-5.2"
      assert profile.raw["source_metadata"]["routing_rule_id"] == "route-1"
    end

    test "normalizes platform camelCase keys to runtime profile keys" do
      assert {:ok, profile} =
               ExecutionProfile.validate(%{
                 "agentId" => "agent-1",
                 "workspaceId" => "workspace-1",
                 "runnerKind" => "codex",
                 "provider" => "openai",
                 "credentialRef" => %{"type" => "credential_id", "value" => "cred-1"},
                 "fallbacks" => [
                   %{
                     "provider" => "anthropic",
                     "model" => "claude-opus-4-7",
                     "credentialRef" => %{"type" => "credential_id", "value" => "cred-2"}
                   }
                 ],
                 "modelTierFloor" => "frontier",
                 "toolProfile" => "coding"
               })

      assert profile.agent_id == "agent-1"
      assert profile.workspace_id == "workspace-1"
      assert profile.tool_profile == "coding"
      assert profile.raw["credential_ref"]["value"] == "cred-1"
      assert profile.model_tier_floor == "frontier"

      assert profile.fallbacks == [
               %{
                 "provider" => "anthropic",
                 "model" => "claude-opus-4-7",
                 "credential_ref" => %{"type" => "credential_id", "value" => "cred-2"}
               }
             ]
    end

    test "accepts string credential refs" do
      assert {:ok, profile} =
               ExecutionProfile.validate(%{
                 "runner_kind" => "codex",
                 "provider" => "openai",
                 "credential_ref" => "credential_alias:default-openai"
               })

      assert profile.credential_ref == "credential_alias:default-openai"
      assert profile.raw["credential_ref"] == "credential_alias:default-openai"
    end

    test "rejects missing required fields" do
      assert {:error, changeset} = ExecutionProfile.validate(%{"provider" => "openai"})

      assert %{runner_kind: ["can't be blank"]} = errors_on(changeset)
    end

    test "rejects unknown runner kinds" do
      assert {:error, changeset} =
               ExecutionProfile.validate(%{
                 "runner_kind" => "not_a_runner",
                 "provider" => "openai"
               })

      assert %{runner_kind: ["is invalid"]} = errors_on(changeset)
    end

    test "rejects unknown model tier floors" do
      assert {:error, changeset} =
               ExecutionProfile.validate(%{
                 "runner_kind" => "codex",
                 "provider" => "openai",
                 "model_tier_floor" => "tiny"
               })

      assert %{model_tier_floor: ["is invalid"]} = errors_on(changeset)
    end

    test "rejects malformed agent ids" do
      assert {:error, changeset} =
               ExecutionProfile.validate(%{
                 "agent_id" => %{"id" => "agent-1"},
                 "runner_kind" => "codex",
                 "provider" => "openai"
               })

      assert %{agent_id: ["is invalid"]} = errors_on(changeset)
    end
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Regex.replace(~r"%{(\w+)}", message, fn _, key ->
        opts |> Keyword.fetch!(String.to_existing_atom(key)) |> to_string()
      end)
    end)
  end
end
