defmodule SymphonyElixir.LogFileTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.LogFile

  test "default_log_file/0 uses the current working directory" do
    assert LogFile.default_log_file() == Path.join(File.cwd!(), "log/symphony.log")
  end

  test "default_log_file/1 builds the log path under a custom root" do
    assert LogFile.default_log_file("/tmp/symphony-logs") == "/tmp/symphony-logs/log/symphony.log"
  end

  test "configure/0 keeps startup alive when the log directory cannot be created" do
    root =
      Path.join(System.tmp_dir!(), "symphony-log-file-test-#{System.unique_integer([:positive])}")

    File.write!(root, "not a directory")

    original_log_file = Application.get_env(:symphony_elixir, :log_file)
    original_max_bytes = Application.get_env(:symphony_elixir, :log_file_max_bytes)
    original_max_files = Application.get_env(:symphony_elixir, :log_file_max_files)

    Application.put_env(:symphony_elixir, :log_file, Path.join([root, "nested", "symphony.log"]))

    try do
      assert :ok = LogFile.configure()
    after
      restore_env(:log_file, original_log_file)
      restore_env(:log_file_max_bytes, original_max_bytes)
      restore_env(:log_file_max_files, original_max_files)
      File.rm(root)
    end
  end

  defp restore_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_env(key, value), do: Application.put_env(:symphony_elixir, key, value)
end
