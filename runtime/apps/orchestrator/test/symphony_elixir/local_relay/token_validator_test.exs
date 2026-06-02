defmodule SymphonyElixir.LocalRelay.TokenValidatorTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRelay.TokenValidator

  setup do
    original_hashes = Application.get_env(:symphony_elixir, :local_relay_token_hashes)

    on_exit(fn ->
      if original_hashes,
        do: Application.put_env(:symphony_elixir, :local_relay_token_hashes, original_hashes),
        else: Application.delete_env(:symphony_elixir, :local_relay_token_hashes)
    end)

    :ok
  end

  test "validates configured token hashes without storing raw token material" do
    Application.put_env(:symphony_elixir, :local_relay_token_hashes, %{
      TokenValidator.hash_token("secret-token") => %{
        "workspace_id" => "workspace-1",
        "machine_id" => "machine-1",
        "token_id" => "token-1"
      }
    })

    assert {:ok, metadata} =
             TokenValidator.validate("secret-token", %{
               workspace_id: "workspace-1",
               machine_id: "machine-1"
             })

    assert metadata.workspace_id == "workspace-1"
    assert metadata.machine_id == "machine-1"
    assert metadata.token_id == "token-1"
  end

  test "rejects revoked and mismatched tokens with local relay safe error atoms" do
    Application.put_env(:symphony_elixir, :local_relay_token_hashes, %{
      TokenValidator.hash_token("revoked") => %{
        workspace_id: "workspace-1",
        machine_id: "machine-1",
        revoked?: true
      },
      TokenValidator.hash_token("mismatch") => %{
        workspace_id: "workspace-1",
        machine_id: "machine-1",
        revoked?: false
      }
    })

    assert {:error, :local_runtime_token_revoked} =
             TokenValidator.validate("revoked", %{workspace_id: "workspace-1", machine_id: "machine-1"})

    assert {:error, :workspace_mismatch} =
             TokenValidator.validate("mismatch", %{workspace_id: "workspace-2", machine_id: "machine-1"})
  end
end
