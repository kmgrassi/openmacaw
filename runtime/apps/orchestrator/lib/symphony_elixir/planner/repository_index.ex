defmodule SymphonyElixir.Planner.RepositoryIndex do
  @moduledoc """
  Read-only repository symbol index used by planner repository tools.

  The index is intentionally heuristic. Raw repository reads remain the
  source-of-truth path, while this cache gives planning agents a fast first pass
  over definitions, routes, and tests without exposing shell access.
  """

  use GenServer

  alias SymphonyElixir.PathSafety

  @ignore_dir_names MapSet.new(~w(.git .hg .svn _build deps node_modules coverage tmp .elixir_ls))
  @ignore_dir_segments [["priv", "static"]]
  @secret_file_patterns [
    ~r/(^|\/)\.env(\.|$)/i,
    ~r/(^|\/)\.npmrc$/i,
    ~r/(^|\/)\.netrc$/i,
    ~r/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
    ~r/(^|\/).*(secret|credential|token|private[_-]?key).*/i
  ]
  @max_files 2_000
  @max_file_bytes 256_000
  @max_line_bytes 1_000
  @default_limit 50
  @supported_extensions ~w(.ex .exs .js .jsx .ts .tsx .py .rb .go .rs .java .kt .swift .heex .eex)

  @type symbol :: %{
          path: String.t(),
          line: pos_integer(),
          kind: String.t(),
          name: String.t(),
          signature: String.t()
        }

  @type index :: %{
          root: Path.t(),
          indexed_at: DateTime.t(),
          symbols: [symbol()],
          stats: map()
        }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, Keyword.put_new(opts, :name, __MODULE__))
  end

  @impl true
  def init(state), do: {:ok, state}

  @spec get_or_build(Path.t(), keyword()) :: {:ok, index()} | {:error, term()}
  def get_or_build(root, opts \\ []) when is_binary(root) do
    with {:ok, canonical_root} <- canonical_root(root) do
      server = Keyword.get(opts, :server, __MODULE__)

      if process_alive?(server) do
        call_index_server(server, {:get_or_build, canonical_root, opts}, Keyword.get(opts, :timeout, 30_000))
      else
        build(canonical_root, opts)
      end
    end
  end

  @spec refresh_async(Path.t(), keyword()) :: :ok | {:error, term()}
  def refresh_async(root, opts \\ []) when is_binary(root) do
    with {:ok, canonical_root} <- canonical_root(root) do
      server = Keyword.get(opts, :server, __MODULE__)

      if process_alive?(server) do
        GenServer.cast(server, {:refresh, canonical_root, opts})
        :ok
      else
        {:error, :repository_index_not_started}
      end
    end
  end

  @spec build(Path.t(), keyword()) :: {:ok, index()} | {:error, term()}
  def build(root, opts \\ []) when is_binary(root) do
    with {:ok, canonical_root} <- canonical_root(root),
         {:ok, files} <- list_indexable_files(canonical_root, opts) do
      symbols = files |> Enum.flat_map(&extract_file_symbols(canonical_root, &1, opts))

      {:ok,
       %{
         root: canonical_root,
         indexed_at: DateTime.utc_now(),
         symbols: symbols,
         stats: %{
           files_indexed: length(files),
           symbols_indexed: length(symbols)
         }
       }}
    end
  end

  defp call_index_server(server, message, timeout) do
    GenServer.call(server, message, timeout)
  catch
    :exit, {:timeout, _call} -> {:error, :repository_index_timeout}
    :exit, reason -> {:error, {:repository_index_call_failed, reason}}
  end

  @spec read_symbols(Path.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def read_symbols(root, args, opts \\ []) when is_binary(root) and is_map(args) do
    with {:ok, index} <- get_or_build(root, opts),
         {:ok, request} <- normalize_read_request(args) do
      symbols =
        index.symbols
        |> filter_path(request.path)
        |> filter_kinds(request.kinds)
        |> filter_query(request.query)
        |> Enum.take(request.limit)

      {:ok,
       %{
         "root" => index.root,
         "indexedAt" => DateTime.to_iso8601(index.indexed_at),
         "stats" => stringify_stats(index.stats),
         "symbols" => Enum.map(symbols, &stringify_symbol/1)
       }}
    end
  end

  @impl true
  def handle_call({:get_or_build, root, opts}, _from, state) do
    case Map.get(state, root) do
      nil ->
        case build(root, opts) do
          {:ok, index} -> {:reply, {:ok, index}, Map.put(state, root, index)}
          {:error, _} = error -> {:reply, error, state}
        end

      index ->
        {:reply, {:ok, index}, state}
    end
  end

  @impl true
  def handle_cast({:refresh, root, opts}, state) do
    case build(root, opts) do
      {:ok, index} -> {:noreply, Map.put(state, root, index)}
      {:error, _reason} -> {:noreply, state}
    end
  end

  defp process_alive?(server) when is_pid(server), do: Process.alive?(server)

  defp process_alive?(server) do
    case whereis(server) do
      nil -> false
      pid when is_pid(pid) -> Process.alive?(pid)
    end
  end

  defp whereis(server) do
    GenServer.whereis(server)
  rescue
    _ -> nil
  end

  defp canonical_root(root) do
    case PathSafety.canonicalize(root) do
      {:ok, canonical} ->
        if File.dir?(canonical), do: {:ok, canonical}, else: {:error, {:invalid_repository_root, canonical}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp list_indexable_files(root, opts) do
    max_files = Keyword.get(opts, :max_files, @max_files)

    root
    |> walk(root, [], max_files)
    |> then(&{:ok, Enum.reverse(&1)})
  end

  defp walk(_root, _dir, acc, max_files) when length(acc) >= max_files, do: acc

  defp walk(root, dir, acc, max_files) do
    case File.ls(dir) do
      {:ok, entries} ->
        Enum.reduce_while(entries, acc, fn entry, file_acc ->
          if length(file_acc) >= max_files do
            {:halt, file_acc}
          else
            path = Path.join(dir, entry)

            next_acc =
              case File.lstat(path) do
                {:ok, %File.Stat{type: :directory}} ->
                  if ignored_directory?(root, path, entry), do: file_acc, else: walk(root, path, file_acc, max_files)

                {:ok, %File.Stat{type: :regular}} ->
                  if indexable_file?(path), do: [path | file_acc], else: file_acc

                _ ->
                  file_acc
              end

            {:cont, next_acc}
          end
        end)

      {:error, _reason} ->
        acc
    end
  end

  defp indexable_file?(path) do
    ext = Path.extname(path)

    ext in @supported_extensions and
      not secret_like?(path) and
      File.stat!(path).size <= @max_file_bytes and
      not String.contains?(path, <<0>>)
  rescue
    _ -> false
  end

  defp ignored_directory?(root, path, entry) do
    MapSet.member?(@ignore_dir_names, entry) or
      Enum.any?(@ignore_dir_segments, fn segments ->
        Path.split(Path.relative_to(path, root)) == segments
      end)
  end

  defp secret_like?(path) do
    Enum.any?(@secret_file_patterns, &Regex.match?(&1, path))
  end

  defp extract_file_symbols(root, path, _opts) do
    relative = Path.relative_to(path, root)

    path
    |> File.stream!([], :line)
    |> Stream.with_index(1)
    |> Stream.flat_map(fn {line, line_number} ->
      line = line |> String.trim() |> String.slice(0, @max_line_bytes)
      extract_line_symbols(relative, line, line_number)
    end)
    |> Enum.to_list()
  rescue
    _ -> []
  end

  defp extract_line_symbols(path, line, line_number) do
    extension = Path.extname(path)
    base = path_based_symbols(path, line, line_number)

    base ++
      case extension do
        ext when ext in [".ex", ".exs"] -> elixir_symbols(path, line, line_number)
        ext when ext in [".js", ".jsx", ".ts", ".tsx"] -> javascript_symbols(path, line, line_number)
        ".py" -> python_symbols(path, line, line_number)
        ".rb" -> ruby_symbols(path, line, line_number)
        ".go" -> regex_symbol(path, line, line_number, ~r/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)/, "function")
        ".rs" -> regex_symbol(path, line, line_number, ~r/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, "function")
        ".java" -> regex_symbol(path, line, line_number, ~r/^(?:public|private|protected)?\s*(?:static\s+)?(?:[\w<>\[\]]+\s+)+([A-Za-z_]\w*)\s*\(/, "function")
        ".kt" -> regex_symbol(path, line, line_number, ~r/^(?:private\s+|public\s+|internal\s+)?fun\s+([A-Za-z_]\w*)/, "function")
        ".swift" -> regex_symbol(path, line, line_number, ~r/^(?:public\s+|private\s+|internal\s+)?func\s+([A-Za-z_]\w*)/, "function")
        _ -> []
      end
  end

  defp path_based_symbols(path, line, line_number) do
    cond do
      String.contains?(path, "/test/") or String.ends_with?(path, "_test.exs") or String.ends_with?(path, ".test.ts") ->
        test_symbol(path, line, line_number)

      Regex.match?(~r/(router|routes)\.(ex|exs|rb|js|ts)$/, path) and route_line?(line) ->
        [symbol(path, line_number, "route", line, line)]

      true ->
        []
    end
  end

  defp test_symbol(path, line, line_number) do
    case Regex.run(~r/^(?:test|describe)\s+["']([^"']+)["']/, line) do
      [_, name] -> [symbol(path, line_number, "test", name, line)]
      _ -> []
    end
  end

  defp route_line?(line), do: Regex.match?(~r/\b(get|post|put|patch|delete|live|resources|scope)\b/, line)

  defp elixir_symbols(path, line, line_number) do
    regex_symbol(path, line, line_number, ~r/^defmodule\s+([A-Za-z0-9_.]+)/, "module") ++
      regex_symbol(path, line, line_number, ~r/^def(?:p|macro)?\s+([a-zA-Z_][\w!?]*)/, "function")
  end

  defp javascript_symbols(path, line, line_number) do
    regex_symbol(path, line, line_number, ~r/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "function") ++
      regex_symbol(path, line, line_number, ~r/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/, "function") ++
      regex_symbol(path, line, line_number, ~r/^(?:export\s+)?(?:class|interface|type)\s+([A-Za-z_$][\w$]*)/, "type")
  end

  defp python_symbols(path, line, line_number) do
    regex_symbol(path, line, line_number, ~r/^class\s+([A-Za-z_]\w*)/, "type") ++
      regex_symbol(path, line, line_number, ~r/^def\s+([A-Za-z_]\w*)/, "function")
  end

  defp ruby_symbols(path, line, line_number) do
    regex_symbol(path, line, line_number, ~r/^class\s+([A-Za-z_:]\w*)/, "type") ++
      regex_symbol(path, line, line_number, ~r/^def\s+([A-Za-z_]\w*[!?=]?)/, "function")
  end

  defp regex_symbol(path, line, line_number, regex, kind) do
    case Regex.run(regex, line) do
      [_, name | _] -> [symbol(path, line_number, kind, name, line)]
      _ -> []
    end
  end

  defp symbol(path, line, kind, name, signature) do
    %{path: path, line: line, kind: kind, name: name, signature: signature}
  end

  defp normalize_read_request(args) do
    limit = normalize_limit(Map.get(args, "limit") || Map.get(args, :limit))

    with {:ok, path} <- normalize_path(Map.get(args, "path") || Map.get(args, :path)) do
      {:ok,
       %{
         limit: limit,
         query: normalize_string(Map.get(args, "query") || Map.get(args, :query)),
         path: path,
         kinds: normalize_kinds(Map.get(args, "kinds") || Map.get(args, :kinds))
       }}
    end
  end

  defp normalize_limit(value) when is_integer(value), do: value |> max(1) |> min(200)

  defp normalize_limit(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, _} -> normalize_limit(int)
      :error -> @default_limit
    end
  end

  defp normalize_limit(_value), do: @default_limit

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> String.downcase(trimmed)
    end
  end

  defp normalize_string(_value), do: nil

  defp normalize_path(value) when is_binary(value) do
    value
    |> String.trim()
    |> String.trim_leading("/")
    |> case do
      "" -> {:ok, nil}
      "." -> {:ok, nil}
      path -> validate_relative_path(path)
    end
  end

  defp normalize_path(_value), do: {:ok, nil}

  defp validate_relative_path(path) do
    segments = Path.split(path)

    if Enum.any?(segments, &(&1 in ["..", ".", ""])) do
      {:error, {:invalid_repository_path, path}}
    else
      {:ok, path}
    end
  end

  defp normalize_kinds(values) when is_list(values) do
    values
    |> Enum.map(&normalize_string/1)
    |> Enum.reject(&is_nil/1)
    |> MapSet.new()
  end

  defp normalize_kinds(_values), do: MapSet.new()

  defp filter_path(symbols, nil), do: symbols
  defp filter_path(symbols, path), do: Enum.filter(symbols, &String.starts_with?(&1.path, path))

  defp filter_kinds(symbols, kinds) do
    if MapSet.size(kinds) == 0 do
      symbols
    else
      Enum.filter(symbols, &MapSet.member?(kinds, &1.kind))
    end
  end

  defp filter_query(symbols, nil), do: symbols

  defp filter_query(symbols, query) do
    Enum.filter(symbols, fn symbol ->
      Enum.any?([symbol.path, symbol.name, symbol.signature, symbol.kind], &(String.downcase(to_string(&1)) =~ query))
    end)
  end

  defp stringify_symbol(symbol) do
    %{
      "path" => symbol.path,
      "line" => symbol.line,
      "kind" => symbol.kind,
      "name" => symbol.name,
      "signature" => symbol.signature
    }
  end

  defp stringify_stats(stats) do
    Map.new(stats, fn {key, value} -> {to_string(key), value} end)
  end
end
