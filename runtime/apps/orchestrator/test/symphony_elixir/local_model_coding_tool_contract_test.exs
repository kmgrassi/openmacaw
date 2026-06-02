defmodule SymphonyElixir.LocalModelCodingToolContractTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ToolSpec

  @schema_path Path.expand("../../docs/local-model-coding-tool-contract.schema.json", __DIR__)

  test "contract JSON defines the R1 coding tool surface" do
    contract = load_contract()

    assert contract["version"] == 1
    assert Map.has_key?(contract["$defs"], "repo_list_parameters")
    assert Map.has_key?(contract["$defs"], "repo_read_file_parameters")
    assert Map.has_key?(contract["$defs"], "repo_search_parameters")
    assert Map.has_key?(contract["$defs"], "shell_exec_parameters")
    assert Map.has_key?(contract["$defs"], "apply_patch_parameters")
    assert Map.has_key?(contract["$defs"], "command_action")

    assert tool_names(contract) == ["apply_patch", "repo.list", "repo.read_file", "repo.search", "shell.exec"]

    repo_list = tool(contract, "repo.list")
    assert repo_list["writes"] == false
    assert repo_list["parameters_schema"] == %{"$ref" => "#/$defs/repo_list_parameters"}
    assert repo_list["result_schema"] == %{"$ref" => "#/$defs/repo_list_result"}

    repo_read_file = tool(contract, "repo.read_file")
    assert repo_read_file["writes"] == false
    assert repo_read_file["parameters_schema"] == %{"$ref" => "#/$defs/repo_read_file_parameters"}
    assert repo_read_file["result_schema"] == %{"$ref" => "#/$defs/repo_read_file_result"}

    repo_search = tool(contract, "repo.search")
    assert repo_search["writes"] == false
    assert repo_search["parameters_schema"] == %{"$ref" => "#/$defs/repo_search_parameters"}
    assert repo_search["result_schema"] == %{"$ref" => "#/$defs/repo_search_result"}

    assert get_in(contract, ["$defs", "repo_search_result", "properties", "matches", "items", "properties", "column", "type"]) == [
             "integer",
             "null"
           ]

    shell_exec = tool(contract, "shell.exec")
    assert shell_exec["writes"] == true
    assert shell_exec["parameters_schema"] == get_in(contract, ["$defs", "shell_exec_parameters"])
    assert shell_exec["result_schema"] == %{"$ref" => "#/$defs/shell_exec_result"}

    apply_patch = tool(contract, "apply_patch")
    assert apply_patch["writes"] == true
    assert apply_patch["parameters_schema"] == get_in(contract, ["$defs", "apply_patch_parameters"])
    assert apply_patch["result_schema"] == %{"$ref" => "#/$defs/apply_patch_result"}
  end

  test "shell.exec input schema requires argv command execution" do
    params = get_in(load_contract(), ["$defs", "shell_exec_parameters"])

    assert params["required"] == ["argv"]
    assert params["properties"]["argv"]["type"] == "array"
    assert params["properties"]["argv"]["minItems"] == 1
    assert params["additionalProperties"] == false
    assert params["properties"]["cwd"]["description"] =~ "Workspace-relative"
  end

  test "repository search input schema is bounded and workspace-scoped" do
    params = get_in(load_contract(), ["$defs", "repo_search_parameters"])

    assert params["required"] == ["query"]
    assert params["properties"]["query"]["type"] == "string"
    assert params["properties"]["query"]["minLength"] == 1
    assert params["properties"]["limit"]["minimum"] == 1
    assert params["properties"]["snippet_chars"]["minimum"] == 40
    assert params["additionalProperties"] == false
  end

  test "command action and approval vocabularies match the R1 scope" do
    defs = load_contract()["$defs"]

    assert get_in(defs, ["command_action", "properties", "action", "enum"]) == [
             "read",
             "listFiles",
             "search",
             "unknown"
           ]

    assert defs["approval_policy"]["enum"] == ["never", "on-request", "on-failure"]

    assert defs["approval_outcome"]["enum"] == [
             "approved",
             "denied",
             "not_required",
             "requires_interaction",
             "unavailable"
           ]
  end

  test "normalized event vocabulary covers command patch approval and turn events" do
    contract = load_contract()
    event_types = Enum.map(contract["events"], & &1["type"])

    assert event_types == get_in(contract, ["$defs", "event_type", "enum"])

    for event_type <- [
          "turn_started",
          "message.delta",
          "tool_call_started",
          "tool_call_completed",
          "tool_call_failed",
          "command_started",
          "command_output_delta",
          "command_completed",
          "patch_apply_begin",
          "patch_apply_end",
          "file_change_pending_approval",
          "approval_required",
          "turn_completed",
          "turn_failed"
        ] do
      assert event_type in event_types
    end
  end

  test "tool specs translate to OpenAI-compatible provider function format" do
    tools =
      load_contract()
      |> Map.fetch!("tools")
      |> Enum.map(fn tool ->
        %{
          "name" => tool["name"],
          "description" => tool["description"],
          "parameters_schema" => tool["parameters_schema"]
        }
      end)

    assert Enum.map(ToolSpec.to_provider_format(tools, :openai_compatible), &get_in(&1, ["function", "name"])) == [
             "repo.read_file",
             "repo.list",
             "repo.search",
             "shell.exec",
             "apply_patch"
           ]
  end

  defp load_contract do
    @schema_path
    |> File.read!()
    |> Jason.decode!()
  end

  defp tool_names(contract) do
    contract
    |> Map.fetch!("tools")
    |> Enum.map(& &1["name"])
    |> Enum.sort()
  end

  defp tool(contract, name) do
    Enum.find(contract["tools"], &(&1["name"] == name))
  end
end
