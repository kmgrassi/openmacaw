defmodule SymphonyElixir.SupabaseTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Supabase

  @env_url "SUPABASE_URL"
  @env_key "SUPABASE_SERVICE_ROLE_KEY"

  setup do
    prior_url = System.get_env(@env_url)
    prior_key = System.get_env(@env_key)

    on_exit(fn ->
      set_env(@env_url, prior_url)
      set_env(@env_key, prior_key)
    end)

    set_env(@env_url, nil)
    set_env(@env_key, nil)
    :ok
  end

  describe "rest_endpoint/1" do
    test "uses SUPABASE_URL from the environment and appends /rest/v1" do
      System.put_env(@env_url, "https://abc.supabase.co")
      assert {:ok, "https://abc.supabase.co/rest/v1"} = Supabase.rest_endpoint()
    end

    test "trims a trailing slash before appending /rest/v1" do
      System.put_env(@env_url, "https://abc.supabase.co/")
      assert {:ok, "https://abc.supabase.co/rest/v1"} = Supabase.rest_endpoint()
    end

    test "does not double-append /rest/v1 when already present" do
      System.put_env(@env_url, "https://abc.supabase.co/rest/v1")
      assert {:ok, "https://abc.supabase.co/rest/v1"} = Supabase.rest_endpoint()
    end

    test "tolerates a trailing slash on an already-prefixed URL" do
      System.put_env(@env_url, "https://abc.supabase.co/rest/v1/")
      assert {:ok, "https://abc.supabase.co/rest/v1"} = Supabase.rest_endpoint()
    end

    test "prefers an :endpoint override as keyword list" do
      System.put_env(@env_url, "https://env.supabase.co")

      assert {:ok, "https://override.supabase.co/rest/v1"} =
               Supabase.rest_endpoint(endpoint: "https://override.supabase.co")
    end

    test "prefers an :endpoint override as map" do
      System.put_env(@env_url, "https://env.supabase.co")

      assert {:ok, "https://override.supabase.co/rest/v1"} =
               Supabase.rest_endpoint(%{endpoint: "https://override.supabase.co"})
    end

    test "falls back to the env var when the override endpoint is nil" do
      System.put_env(@env_url, "https://env.supabase.co")

      assert {:ok, "https://env.supabase.co/rest/v1"} =
               Supabase.rest_endpoint(%{endpoint: nil})
    end

    test "returns {:error, :missing} when neither source is set" do
      assert {:error, :missing} = Supabase.rest_endpoint()
      assert {:error, :missing} = Supabase.rest_endpoint(%{})
      assert {:error, :missing} = Supabase.rest_endpoint(%{endpoint: ""})
    end
  end

  describe "rest_endpoint!/1" do
    test "returns the URL when available" do
      System.put_env(@env_url, "https://abc.supabase.co")
      assert "https://abc.supabase.co/rest/v1" = Supabase.rest_endpoint!()
    end

    test "raises with an actionable message when nothing is configured" do
      assert_raise ArgumentError, ~r/SUPABASE_URL.*:endpoint/, fn ->
        Supabase.rest_endpoint!()
      end
    end
  end

  describe "service_role_key/1" do
    test "uses SUPABASE_SERVICE_ROLE_KEY from the environment" do
      System.put_env(@env_key, "env-key")
      assert {:ok, "env-key"} = Supabase.service_role_key()
    end

    test "prefers an :api_key override" do
      System.put_env(@env_key, "env-key")
      assert {:ok, "override-key"} = Supabase.service_role_key(api_key: "override-key")
    end

    test "returns {:error, :missing} when neither source is set" do
      assert {:error, :missing} = Supabase.service_role_key()
      assert {:error, :missing} = Supabase.service_role_key(%{api_key: ""})
    end
  end

  describe "service_role_key!/1" do
    test "raises with an actionable message when nothing is configured" do
      assert_raise ArgumentError, ~r/SUPABASE_SERVICE_ROLE_KEY.*:api_key/, fn ->
        Supabase.service_role_key!()
      end
    end
  end

  describe "merge_connection!/1" do
    test "merges endpoint and api_key into an opts map resolved from env" do
      System.put_env(@env_url, "https://abc.supabase.co")
      System.put_env(@env_key, "env-key")

      assert %{
               endpoint: "https://abc.supabase.co/rest/v1",
               api_key: "env-key",
               table: "agent"
             } = Supabase.merge_connection!(%{table: "agent"})
    end

    test "overrides take precedence over env" do
      System.put_env(@env_url, "https://env.supabase.co")
      System.put_env(@env_key, "env-key")

      assert %{endpoint: "https://override.supabase.co/rest/v1", api_key: "override-key"} =
               Supabase.merge_connection!(%{
                 endpoint: "https://override.supabase.co",
                 api_key: "override-key"
               })
    end

    test "raises when endpoint is missing" do
      System.put_env(@env_key, "env-key")
      assert_raise ArgumentError, ~r/PostgREST endpoint is not configured/, fn ->
        Supabase.merge_connection!(%{})
      end
    end

    test "raises when api key is missing" do
      System.put_env(@env_url, "https://abc.supabase.co")
      assert_raise ArgumentError, ~r/service role key is not configured/, fn ->
        Supabase.merge_connection!(%{})
      end
    end
  end

  defp set_env(name, nil), do: System.delete_env(name)
  defp set_env(name, value), do: System.put_env(name, value)
end
