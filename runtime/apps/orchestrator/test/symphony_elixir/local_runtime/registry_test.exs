defmodule SymphonyElixir.LocalRuntime.RegistryTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRuntime.Registry

  setup do
    if Process.whereis(Registry) == nil do
      start_supervised!(Registry)
    end

    Registry.clear()
    :ok
  end

  test "stores latest registered and probed model capabilities" do
    assert {:ok, [_entry]} =
             Registry.register(%{
               "workspace_id" => "workspace-1",
               "machine_id" => "machine-1",
               "runner_kind" => "openai_compatible",
               "provider" => "ollama",
               "model" => "qwen",
               "capabilities" => %{"streaming" => true}
             })

    assert {:ok, [_entry]} =
             Registry.probe(%{
               "workspace_id" => "workspace-1",
               "machine_id" => "machine-1",
               "runner_kind" => "openai_compatible",
               "provider" => "ollama",
               "model" => "qwen",
               "capabilities" => %{"streaming" => true, "json_mode" => true, "context_window" => 8192}
             })

    assert [entry] = Registry.list(workspace_id: "workspace-1")
    assert entry["source"] == "probe"
    assert entry["capabilities"]["streaming"] == true
    assert entry["capabilities"]["json_mode"] == true
    assert entry["capabilities"]["context_window"] == 8192
  end

  test "filters capability snapshots for platform reporting hooks" do
    Registry.register(%{
      "workspace_id" => "workspace-1",
      "machine_id" => "machine-1",
      "models" => [
        %{"runner_kind" => "openai_compatible", "provider" => "ollama", "model" => "qwen"},
        %{"runner_kind" => "mock", "provider" => "local", "model" => "mock"}
      ]
    })

    Registry.register(%{
      "workspace_id" => "workspace-2",
      "machine_id" => "machine-2",
      "runner_kind" => "openai_compatible",
      "provider" => "lm_studio",
      "model" => "mistral"
    })

    assert [%{"model" => "qwen"}] = Registry.list(workspace_id: "workspace-1", runner_kind: "openai_compatible")
  end

  test "keeps provider-specific snapshots for shared model names" do
    Registry.register(%{
      "workspace_id" => "workspace-1",
      "machine_id" => "machine-1",
      "runner_kind" => "openai_compatible",
      "provider" => "ollama",
      "model" => "mistral",
      "capabilities" => %{"streaming" => true}
    })

    Registry.register(%{
      "workspace_id" => "workspace-1",
      "machine_id" => "machine-1",
      "runner_kind" => "openai_compatible",
      "provider" => "lm_studio",
      "model" => "mistral",
      "capabilities" => %{"json_mode" => true}
    })

    assert [
             %{"provider" => "lm_studio", "capabilities" => %{"json_mode" => true}},
             %{"provider" => "ollama", "capabilities" => %{"streaming" => true}}
           ] = Registry.list(workspace_id: "workspace-1", runner_kind: "openai_compatible", model: "mistral")

    assert [%{"provider" => "ollama"}] = Registry.list(workspace_id: "workspace-1", provider: "ollama")
    assert {:ok, %{"provider" => "lm_studio"}} = Registry.get("workspace-1", "machine-1", "openai_compatible", "lm_studio", "mistral")
  end
end
