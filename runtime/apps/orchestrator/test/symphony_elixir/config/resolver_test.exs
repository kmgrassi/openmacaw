defmodule SymphonyElixir.Config.ResolverTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Config.{PathResolver, SecretResolver}

  import SymphonyElixir.TestSupport, only: [delete_system_env: 1, put_system_env: 2]

  describe "SecretResolver.expand_env/2" do
    test "returns fallback for missing env tokens" do
      env_name = unique_env("MISSING")
      delete_system_env(env_name)

      assert SecretResolver.expand_env("$#{env_name}", "fallback") == "fallback"
    end

    test "normalizes empty env tokens to nil" do
      env_name = unique_env("EMPTY")
      put_system_env(env_name, "")

      assert SecretResolver.expand_env("$#{env_name}", "fallback") == nil
      assert SecretResolver.resolve_setting("$#{env_name}", "fallback") == nil
    end

    test "only expands whole env tokens" do
      env_name = unique_env("TOKEN")
      put_system_env(env_name, "resolved")

      assert SecretResolver.expand_env("$#{env_name}", nil) == "resolved"
      assert SecretResolver.expand_env("prefix-$#{env_name}", nil) == "prefix-$#{env_name}"
      assert SecretResolver.expand_env("$#{env_name}/nested", nil) == "$#{env_name}/nested"
    end
  end

  describe "PathResolver" do
    test "path values fall back on missing or empty env tokens" do
      missing_env = unique_env("PATH_MISSING")
      empty_env = unique_env("PATH_EMPTY")
      delete_system_env(missing_env)
      put_system_env(empty_env, "")

      assert PathResolver.resolve_path_value("$#{missing_env}", "/default") == "/default"
      assert PathResolver.resolve_path_value("$#{empty_env}", "/default") == "/default"
    end

    test "storage values preserve URIs and expand local paths" do
      assert PathResolver.resolve_storage_value("s3://bucket/prefix", "/default") ==
               "s3://bucket/prefix"

      assert PathResolver.resolve_storage_value("relative/path", "/default") ==
               Path.expand("relative/path")
    end
  end

  defp unique_env(prefix), do: "SYMPHONY_#{prefix}_#{System.unique_integer([:positive])}"
end
