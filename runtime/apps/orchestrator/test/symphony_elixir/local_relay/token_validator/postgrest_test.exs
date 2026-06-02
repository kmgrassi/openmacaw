defmodule SymphonyElixir.LocalRelay.TokenValidator.PostgRESTTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias SymphonyElixir.LocalRelay.TokenValidator
  alias SymphonyElixir.LocalRelay.TokenValidator.PostgREST, as: Validator

  @plaintext_token "test-helper-token"
  @token_hash TokenValidator.hash_token(@plaintext_token)

  setup do
    Application.put_env(:symphony_elixir, Validator,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    Application.put_env(:symphony_elixir, :local_relay_token_validator_req_options,
      plug: {Req.Test, __MODULE__}
    )

    # Run the last_used_at touch inline so the PATCH is observable in-test.
    Application.put_env(:symphony_elixir, :local_relay_token_validator_db_touch_mode, :sync)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, Validator)
      Application.delete_env(:symphony_elixir, :local_relay_token_validator_req_options)
      Application.delete_env(:symphony_elixir, :local_relay_token_validator_db_touch_mode)
    end)

    :ok
  end

  defp active_row(overrides \\ %{}) do
    machine =
      Map.merge(
        %{
          "id" => "machine-1",
          "workspace_id" => "workspace-1",
          "runner_kinds" => ["openai_compatible", "local"]
        },
        Map.get(overrides, :machine, %{})
      )

    %{"id" => "token-1", "local_runtime_machine" => machine}
  end

  # Stubs both the GET (validate) and the PATCH (touch_last_used), forwarding
  # the request shape to the test process for assertions.
  defp stub(get_rows) do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case conn.method do
        "GET" ->
          send(test_pid, {:get, conn.request_path, URI.decode_query(conn.query_string)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!(get_rows))

        "PATCH" ->
          send(test_pid, {:patch, conn.request_path, URI.decode_query(conn.query_string)})
          Plug.Conn.send_resp(conn, 204, "")
      end
    end)
  end

  test "returns metadata for an active token, with an inner-join query, and touches last_used_at" do
    stub([active_row()])

    assert {:ok, metadata} =
             Validator.validate(@plaintext_token, %{
               workspace_id: "workspace-1",
               machine_id: "machine-1"
             })

    assert metadata == %{
             workspace_id: "workspace-1",
             machine_id: "machine-1",
             token_id: "token-1",
             runner_kinds: ["openai_compatible", "local"],
             revoked?: false
           }

    assert_received {:get, "/rest/v1/local_runtime_token", params}
    assert params["token_hash"] == "eq.#{@token_hash}"
    assert params["revoked_at"] == "is.null"
    assert params["local_runtime_machine.revoked_at"] == "is.null"
    assert params["select"] =~ "local_runtime_machine!inner(id,workspace_id,runner_kinds)"

    assert_received {:patch, "/rest/v1/local_runtime_token", patch_params}
    assert patch_params["id"] == "eq.token-1"
  end

  test "returns :invalid_token when no active token/machine row matches, and does not touch" do
    stub([])

    log =
      capture_log(fn ->
        assert {:error, :invalid_token} =
                 Validator.validate("unknown-token", %{
                   workspace_id: "workspace-1",
                   machine_id: "machine-1"
                 })
      end)

    assert log =~ "local_relay_token_validation_failed"
    assert log =~ "invalid_token"
    refute_received {:patch, _path, _params}
  end

  test "returns :workspace_mismatch when the machine workspace differs from the helper" do
    stub([active_row()])

    log =
      capture_log(fn ->
        assert {:error, :workspace_mismatch} =
                 Validator.validate(@plaintext_token, %{
                   workspace_id: "workspace-2",
                   machine_id: "machine-1"
                 })
      end)

    assert log =~ "workspace_mismatch"
    refute_received {:patch, _path, _params}
  end

  test "returns :machine_mismatch when the machine differs from the helper" do
    stub([active_row()])

    log =
      capture_log(fn ->
        assert {:error, :machine_mismatch} =
                 Validator.validate(@plaintext_token, %{
                   workspace_id: "workspace-1",
                   machine_id: "machine-2"
                 })
      end)

    assert log =~ "machine_mismatch"
    refute_received {:patch, _path, _params}
  end

  test "missing helper-side workspace/machine attrs do not cause a mismatch" do
    stub([active_row(%{machine: %{"runner_kinds" => nil}})])

    assert {:ok, metadata} = Validator.validate(@plaintext_token, %{})
    assert metadata.workspace_id == "workspace-1"
    assert metadata.machine_id == "machine-1"
    assert metadata.runner_kinds == []
  end

  test "returns :validator_unavailable when the PostgREST request fails" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      send(test_pid, {:get, conn.request_path})
      Plug.Conn.send_resp(conn, 500, ~s({"message":"boom"}))
    end)

    log =
      capture_log(fn ->
        assert {:error, :validator_unavailable} =
                 Validator.validate(@plaintext_token, %{
                   workspace_id: "workspace-1",
                   machine_id: "machine-1"
                 })
      end)

    assert log =~ "validator_unavailable"
    refute_received {:patch, _path, _params}
  end
end
