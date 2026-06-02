defmodule SymphonyElixir.Runner.CommandActionClassifier do
  @moduledoc """
  Best-effort command action classification for coding tool metadata.

  This classifier is intentionally conservative. It is used for UI labels,
  runtime events, and approval hints; workspace validation and tool policy remain
  the security boundary.
  """

  @type action :: :read | :list_files | :search | :unknown
  @type command :: [String.t()] | String.t()

  @shell_wrappers ~w[bash dash fish sh zsh]
  @read_commands ~w[cat head tail]
  @list_commands ~w[ls]
  @search_commands ~w[rg grep]
  @composed_command_pattern ~r/[;&|<>()`$\\]|\n|\r/

  @doc """
  Classify a command as a coarse action.

  Accepts an argv list, which is the preferred shell executor shape, or a simple
  command string. Composed shell commands, shell wrappers, and write-capable
  command flags fall back to `:unknown`.
  """
  @spec classify(command()) :: action()
  def classify(command) do
    command
    |> normalize_argv()
    |> classify_argv()
  end

  @doc "Return event metadata for a command classification."
  @spec metadata(command()) :: map()
  def metadata(command) do
    %{"command_action" => action_name(classify(command))}
  end

  @doc "Convert an action atom to the external event string vocabulary."
  @spec action_name(action()) :: String.t()
  def action_name(:read), do: "read"
  def action_name(:list_files), do: "listFiles"
  def action_name(:search), do: "search"
  def action_name(:unknown), do: "unknown"

  defp classify_argv({:ok, [command | args]}) do
    executable = command |> Path.basename() |> String.downcase()

    cond do
      executable in @shell_wrappers -> :unknown
      executable in @read_commands and read_args?(args) -> :read
      executable == "sed" and sed_read_args?(args) -> :read
      executable in @list_commands and list_args?(args) -> :list_files
      executable == "find" and find_list_args?(args) -> :list_files
      executable in @search_commands and search_args?(args) -> :search
      true -> :unknown
    end
  end

  defp classify_argv(_argv), do: :unknown

  defp normalize_argv(argv) when is_list(argv) do
    if Enum.all?(argv, &simple_arg?/1) do
      {:ok, argv}
    else
      :error
    end
  end

  defp normalize_argv(command) when is_binary(command) do
    command = String.trim(command)

    cond do
      command == "" -> :error
      Regex.match?(@composed_command_pattern, command) -> :error
      true -> split_command(command)
    end
  end

  defp normalize_argv(_command), do: :error

  defp simple_arg?(arg) when is_binary(arg) do
    String.trim(arg) != "" and not Regex.match?(@composed_command_pattern, arg)
  end

  defp simple_arg?(_arg), do: false

  defp split_command(command) do
    {:ok, OptionParser.split(command)}
  rescue
    ArgumentError -> :error
  end

  defp read_args?(args), do: args != [] and safe_read_flags?(args)

  defp safe_read_flags?(args) do
    Enum.all?(args, fn
      "-" <> _flag -> true
      _path -> true
    end)
  end

  defp sed_read_args?(args) do
    args != [] and not Enum.any?(args, &sed_write_arg?/1)
  end

  defp sed_write_arg?("-i"), do: true
  defp sed_write_arg?("--in-place"), do: true
  defp sed_write_arg?("-i" <> suffix) when suffix != "", do: true

  defp sed_write_arg?(arg) when is_binary(arg) do
    Regex.match?(~r/(^|[;[:space:]])(?:\d+|\$)?(?:,(?:\d+|\$)?)?[ew]($|[;[:space:]]|[^;[:space:]])/, arg)
  end

  defp sed_write_arg?(_arg), do: false

  defp list_args?(args), do: Enum.all?(args, &safe_list_arg?/1)

  defp safe_list_arg?("-" <> _flag), do: true
  defp safe_list_arg?(_path), do: true

  defp find_list_args?(args) do
    args != [] and not Enum.any?(args, &find_write_or_exec_arg?/1)
  end

  defp find_write_or_exec_arg?(arg) do
    arg in [
      "-delete",
      "-exec",
      "-execdir",
      "-fdelete",
      "-fls",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-ok",
      "-okdir"
    ]
  end

  defp search_args?(args), do: args != []
end
