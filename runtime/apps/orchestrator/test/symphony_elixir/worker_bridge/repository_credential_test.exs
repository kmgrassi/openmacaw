defmodule SymphonyElixir.WorkerBridge.RepositoryCredentialTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.WorkerBridge.RepositoryCredential

  setup do
    previous_env = Application.get_env(:symphony_elixir, :runtime_env)
    previous_app_env = Application.get_env(:symphony_elixir, :env)
    previous_enforced = Application.get_env(:symphony_elixir, :resource_authorization_enforced)
    previous_resolver = Application.get_env(:symphony_elixir, :worker_bridge_secret_ref_resolver)

    on_exit(fn ->
      restore_app_env(:runtime_env, previous_env)
      restore_app_env(:env, previous_app_env)
      restore_app_env(:resource_authorization_enforced, previous_enforced)
      restore_app_env(:worker_bridge_secret_ref_resolver, previous_resolver)
    end)

    :ok
  end

  test "resolves github app installation tokens without changing the repository URL" do
    assert {:ok, credential} =
             RepositoryCredential.resolve(%{
               "url" => "https://github.com/acme/private",
               "resource_grant" => %{
                 "id" => "grant-1",
                 "credential_ref" => %{
                   "type" => "github_app_installation_token",
                   "id" => "installation-1",
                   "token" => "ghs_short_lived"
                 }
               }
             })

    assert credential.token == "ghs_short_lived"
    assert credential.username == "x-access-token"
    assert credential.source == "github_app_installation_token"
    assert credential.ref == "installation-1"
  end

  test "resolves secret references through the shared secret resolver" do
    test_pid = self()

    Application.put_env(
      :symphony_elixir,
      :worker_bridge_secret_ref_resolver,
      fn secret_ref, aliases ->
        send(test_pid, {:resolve_secret_ref, secret_ref, aliases})
        {:ok, "secret-token"}
      end
    )

    assert {:ok, credential} =
             RepositoryCredential.resolve(%{
               "url" => "https://github.com/acme/private",
               "credential_ref" => %{
                 "source" => "secret_ref",
                 "ref" => "arn:aws:secretsmanager:us-east-1:123:secret:github",
                 "aliases" => ["github_installation_token"]
               }
             })

    assert credential.token == "secret-token"
    assert credential.ref == "arn:aws:secretsmanager:us-east-1:123:secret:github"
    assert_receive {:resolve_secret_ref, "arn:aws:secretsmanager:us-east-1:123:secret:github", ["github_installation_token"]}
  end

  test "production credential injection requires resource authorization enforcement" do
    Application.put_env(:symphony_elixir, :runtime_env, :prod)
    Application.put_env(:symphony_elixir, :resource_authorization_enforced, false)

    repository = %{
      "url" => "https://github.com/acme/private",
      "credential_ref" => %{"source" => "inline", "token" => "secret-token"}
    }

    assert {:error, :resource_authorization_required_for_private_repository_credentials} =
             RepositoryCredential.resolve(repository)

    Application.put_env(:symphony_elixir, :resource_authorization_enforced, true)

    assert {:ok, %RepositoryCredential{token: "secret-token"}} = RepositoryCredential.resolve(repository)
  end

  test "production gate falls back to configured app env without Mix" do
    Application.delete_env(:symphony_elixir, :runtime_env)
    Application.put_env(:symphony_elixir, :env, :prod)
    Application.put_env(:symphony_elixir, :resource_authorization_enforced, false)

    repository = %{
      "url" => "https://github.com/acme/private",
      "credential_ref" => %{"source" => "inline", "token" => "secret-token"}
    }

    assert {:error, :resource_authorization_required_for_private_repository_credentials} =
             RepositoryCredential.resolve(repository)
  end

  defp restore_app_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_app_env(key, value), do: Application.put_env(:symphony_elixir, key, value)
end
