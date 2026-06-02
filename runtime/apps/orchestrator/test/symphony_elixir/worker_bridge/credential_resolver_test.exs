defmodule SymphonyElixir.WorkerBridge.CredentialResolverTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.WorkerBridge.CredentialResolver

  test "resolves inline credentials" do
    assert {:ok, %{"OPENAI_API_KEY" => "abc123"}} =
             CredentialResolver.resolve(%{
               "OPENAI_API_KEY" => %{"source" => "inline", "value" => "abc123"}
             })
  end

  test "resolves env-backed credentials" do
    env_name = "WORKER_BRIDGE_TEST_SECRET_#{System.unique_integer([:positive])}"
    previous = System.get_env(env_name)
    System.put_env(env_name, "resolved-secret")

    on_exit(fn ->
      if previous, do: System.put_env(env_name, previous), else: System.delete_env(env_name)
    end)

    assert {:ok, %{"OPENAI_API_KEY" => "resolved-secret"}} =
             CredentialResolver.resolve(%{
               "OPENAI_API_KEY" => %{"source" => "env", "name" => env_name}
             })
  end

  test "returns structured error for unsupported sources" do
    assert {:error, {:unsupported_credential_source, "OPENAI_API_KEY", "ssm"}} =
             CredentialResolver.resolve(%{
               "OPENAI_API_KEY" => %{"source" => "ssm", "ref" => "/prod/openai/api-key"}
             })
  end
end
