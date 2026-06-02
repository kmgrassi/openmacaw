defmodule SymphonyElixir.SupabaseSchema do
  @moduledoc """
  Helpers for consuming the generated Supabase/PostgREST schema bridge.

  The canonical source of truth remains `supabase/generated/types.ts`; this module
  reads the generated JSON bridge derived from that file so Elixir PostgREST
  consumers can build select lists and validate returned row shapes against the
  canonical row contract.
  """

  @schema_path_candidates [
    Path.expand("../../priv/generated/postgrest-schema.json", __DIR__),
    Path.expand("../../../../supabase/generated/postgrest-schema.json", __DIR__)
  ]

  Enum.each(@schema_path_candidates, fn path ->
    if File.exists?(path) do
      @external_resource path
    end
  end)

  @schema_entries Enum.flat_map(@schema_path_candidates, fn path ->
                    if File.exists?(path) do
                      schema = path |> File.read!() |> Jason.decode!()

                      [
                        %{
                          path: path,
                          schema: schema,
                          table_count: schema |> Map.get("public", %{}) |> map_size()
                        }
                      ]
                    else
                      []
                    end
                  end)

  @schema_entry Enum.max_by(@schema_entries, & &1.table_count, fn -> nil end)

  @schema (case @schema_entry do
             nil ->
               searched = Enum.map_join(@schema_path_candidates, ", ", &inspect/1)
               raise File.Error, reason: :enoent, action: "read Supabase schema from one of", path: searched

             entry ->
               entry.schema
           end)

  @type table_name :: String.t()
  @type column_name :: String.t()
  @type validation_error ::
          {:unknown_table, table_name()}
          | {:unknown_column, table_name(), column_name()}
          | {:missing_column, table_name(), column_name()}
          | {:invalid_column_type, table_name(), column_name(), [String.t()], term()}

  @spec select_columns!(table_name(), :all | [column_name()]) :: String.t()
  def select_columns!(table, columns \\ :all) do
    table
    |> columns!(columns)
    |> Enum.join(",")
  end

  @spec column?(table_name(), column_name()) :: boolean()
  def column?(table, column) when is_binary(table) and is_binary(column) do
    is_map(get_in(@schema, ["public", table, "row", "fields", column]))
  end

  @spec validate_row(table_name(), map(), :all | [column_name()]) :: :ok | {:error, validation_error()}
  def validate_row(table, row, columns \\ :all)

  def validate_row(table, row, columns) when is_map(row) do
    schema = row_schema!(table)

    Enum.reduce_while(columns!(table, columns), :ok, fn column, :ok ->
      with {:ok, value} <- fetch_column(row, column),
           true <- valid_value_kind?(value, allowed_value_kinds(schema, column)) do
        {:cont, :ok}
      else
        :error ->
          {:halt, {:error, {:missing_column, table, column}}}

        false ->
          {:halt, {:error, {:invalid_column_type, table, column, allowed_value_kinds(schema, column), map_fetch(row, column)}}}
      end
    end)
  end

  def validate_row(table, row, _columns),
    do: {:error, {:invalid_column_type, table, "__row__", ["json"], row}}

  @spec validate_rows(table_name(), [map()], :all | [column_name()]) :: :ok | {:error, validation_error()}
  def validate_rows(table, rows, columns \\ :all) when is_list(rows) do
    Enum.reduce_while(rows, :ok, fn row, :ok ->
      case validate_row(table, row, columns) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp row_schema!(table) do
    case get_in(@schema, ["public", table, "row"]) do
      nil -> raise ArgumentError, "unknown Supabase schema table #{inspect(table)}"
      schema -> schema
    end
  end

  defp columns!(table, :all) do
    row_schema!(table)["columns"] || []
  end

  defp columns!(table, columns) when is_list(columns) do
    schema = row_schema!(table)

    Enum.map(columns, fn column ->
      if Map.has_key?(schema["fields"], column) do
        column
      else
        raise ArgumentError, "unknown Supabase schema column #{inspect(table)}.#{inspect(column)}"
      end
    end)
  end

  defp allowed_value_kinds(schema, column) do
    get_in(schema, ["fields", column, "value_kinds"]) || ["unknown"]
  end

  defp fetch_column(row, column) do
    case Map.fetch(row, column) do
      {:ok, value} ->
        {:ok, value}

      :error ->
        atom_key = String.to_atom(column)

        case Map.fetch(row, atom_key) do
          {:ok, value} -> {:ok, value}
          :error -> :error
        end
    end
  rescue
    ArgumentError -> :error
  end

  defp map_fetch(row, column) do
    case fetch_column(row, column) do
      {:ok, value} -> value
      :error -> nil
    end
  end

  defp valid_value_kind?(value, allowed_kinds) do
    value_kind = value_kind(value)
    Enum.member?(allowed_kinds, value_kind)
  end

  defp value_kind(nil), do: "null"
  defp value_kind(value) when is_binary(value), do: "string"
  defp value_kind(value) when is_boolean(value), do: "boolean"
  defp value_kind(value) when is_number(value), do: "number"
  defp value_kind(value) when is_map(value) or is_list(value), do: "json"
  defp value_kind(_value), do: "unknown"
end
