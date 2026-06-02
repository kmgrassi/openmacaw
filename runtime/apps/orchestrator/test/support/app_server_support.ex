defmodule SymphonyElixir.AppServerTestSupport do
  import ExUnit.Assertions

  alias SymphonyElixir.WorkItem

  def with_test_root(prefix, fun) when is_binary(prefix) and is_function(fun, 1) do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "#{prefix}-#{System.unique_integer([:positive])}"
      )

    try do
      fun.(test_root)
    after
      File.rm_rf(test_root)
    end
  end

  def issue(id, identifier, title, description) do
    %WorkItem{
      id: id,
      identifier: identifier,
      title: title,
      description: description,
      state: "In Progress",
      url: "https://example.org/issues/#{identifier}",
      labels: ["backend"]
    }
  end

  def put_env_for_test(key, value) when is_binary(key) do
    previous = System.get_env(key)

    ExUnit.Callbacks.on_exit(fn ->
      case previous do
        nil -> System.delete_env(key)
        _ -> System.put_env(key, previous)
      end
    end)

    System.put_env(key, value)
    :ok
  end

  def write_executable!(path, content) do
    path |> Path.dirname() |> File.mkdir_p!()
    File.write!(path, content)
    File.chmod!(path, 0o755)
  end

  def trace_lines(path) do
    path
    |> File.read!()
    |> String.split("\n", trim: true)
  end

  def json_trace_payloads(lines) do
    lines
    |> Enum.filter(&String.starts_with?(&1, "JSON:"))
    |> Enum.map(fn line ->
      line
      |> String.trim_leading("JSON:")
      |> Jason.decode!()
    end)
  end

  def assert_json_trace(lines, predicate) when is_list(lines) and is_function(predicate, 1) do
    assert Enum.any?(json_trace_payloads(lines), predicate)
  end
end
