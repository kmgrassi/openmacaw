defmodule SymphonyElixir.StatusDashboard.Styling do
  @moduledoc """
  ANSI codes, column widths, and the small formatting primitives
  (`colorize/2`, `format_cell/3`, table chrome) that the snapshot
  formatter and the dashboard root rely on.

  This module is pure: every function takes plain data and returns
  strings or integers. Constants live here so dashboard tweaks don't
  require touching the GenServer.
  """

  @running_id_width 8
  @running_stage_width 14
  @running_pid_width 8
  @running_age_width 12
  @running_tokens_width 10
  @running_session_width 14
  @running_event_default_width 44
  @running_event_min_width 12
  @running_row_chrome_width 10
  @default_terminal_columns 115

  @sparkline_blocks ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

  @ansi_reset IO.ANSI.reset()
  @ansi_bold IO.ANSI.bright()
  @ansi_blue IO.ANSI.blue()
  @ansi_cyan IO.ANSI.cyan()
  @ansi_dim IO.ANSI.faint()
  @ansi_green IO.ANSI.green()
  @ansi_red IO.ANSI.red()
  @ansi_orange IO.ANSI.yellow()
  @ansi_yellow IO.ANSI.yellow()
  @ansi_magenta IO.ANSI.magenta()
  @ansi_gray IO.ANSI.light_black()

  @spec ansi_reset() :: String.t()
  def ansi_reset, do: @ansi_reset
  @spec ansi_bold() :: String.t()
  def ansi_bold, do: @ansi_bold
  @spec ansi_blue() :: String.t()
  def ansi_blue, do: @ansi_blue
  @spec ansi_cyan() :: String.t()
  def ansi_cyan, do: @ansi_cyan
  @spec ansi_dim() :: String.t()
  def ansi_dim, do: @ansi_dim
  @spec ansi_green() :: String.t()
  def ansi_green, do: @ansi_green
  @spec ansi_red() :: String.t()
  def ansi_red, do: @ansi_red
  @spec ansi_orange() :: String.t()
  def ansi_orange, do: @ansi_orange
  @spec ansi_yellow() :: String.t()
  def ansi_yellow, do: @ansi_yellow
  @spec ansi_magenta() :: String.t()
  def ansi_magenta, do: @ansi_magenta
  @spec ansi_gray() :: String.t()
  def ansi_gray, do: @ansi_gray

  @spec running_id_width() :: pos_integer()
  def running_id_width, do: @running_id_width
  @spec running_stage_width() :: pos_integer()
  def running_stage_width, do: @running_stage_width
  @spec running_pid_width() :: pos_integer()
  def running_pid_width, do: @running_pid_width
  @spec running_age_width() :: pos_integer()
  def running_age_width, do: @running_age_width
  @spec running_tokens_width() :: pos_integer()
  def running_tokens_width, do: @running_tokens_width
  @spec running_session_width() :: pos_integer()
  def running_session_width, do: @running_session_width
  @spec running_event_min_width() :: pos_integer()
  def running_event_min_width, do: @running_event_min_width

  @spec sparkline_blocks() :: [String.t()]
  def sparkline_blocks, do: @sparkline_blocks

  @spec colorize(String.t(), String.t()) :: String.t()
  def colorize(value, code), do: "#{code}#{value}#{@ansi_reset}"

  @spec closing_border() :: String.t()
  def closing_border, do: "╰─"

  @spec status_dot(String.t()) :: String.t()
  def status_dot(color_code), do: colorize("●", color_code)

  @spec format_cell(term(), pos_integer()) :: String.t()
  @spec format_cell(term(), pos_integer(), :left | :right) :: String.t()
  def format_cell(value, width, align \\ :left) do
    value =
      value
      |> to_string()
      |> String.replace("\n", " ")
      |> String.replace(~r/\s+/, " ")
      |> String.trim()
      |> truncate_plain(width)

    case align do
      :right -> String.pad_leading(value, width)
      _ -> String.pad_trailing(value, width)
    end
  end

  @spec truncate_plain(String.t(), pos_integer()) :: String.t()
  def truncate_plain(value, width) do
    if byte_size(value) <= width do
      value
    else
      String.slice(value, 0, width - 3) <> "..."
    end
  end

  @spec truncate(String.t(), pos_integer()) :: String.t()
  def truncate(value, max) when byte_size(value) > max do
    value |> String.slice(0, max) |> Kernel.<>("...")
  end

  def truncate(value, _max), do: value

  @spec running_event_width(integer() | nil) :: pos_integer()
  def running_event_width(terminal_columns) do
    terminal_columns = terminal_columns || terminal_columns()

    max(
      @running_event_min_width,
      terminal_columns - fixed_running_width() - @running_row_chrome_width
    )
  end

  @spec fixed_running_width() :: pos_integer()
  def fixed_running_width do
    @running_id_width +
      @running_stage_width +
      @running_pid_width +
      @running_age_width +
      @running_tokens_width +
      @running_session_width
  end

  @spec terminal_columns() :: pos_integer()
  def terminal_columns do
    case :io.columns() do
      {:ok, columns} when is_integer(columns) and columns > 0 ->
        columns

      _ ->
        terminal_columns_from_env()
    end
  end

  defp terminal_columns_from_env do
    case System.get_env("COLUMNS") do
      nil ->
        fixed_running_width() + @running_row_chrome_width + @running_event_default_width

      value ->
        case Integer.parse(String.trim(value)) do
          {columns, ""} when columns > 0 -> columns
          _ -> @default_terminal_columns
        end
    end
  end

  @spec running_table_header_row(pos_integer()) :: String.t()
  def running_table_header_row(running_event_width) do
    header =
      [
        format_cell("ID", @running_id_width),
        format_cell("STAGE", @running_stage_width),
        format_cell("PID", @running_pid_width),
        format_cell("AGE / TURN", @running_age_width),
        format_cell("TOKENS", @running_tokens_width),
        format_cell("SESSION", @running_session_width),
        format_cell("EVENT", running_event_width)
      ]
      |> Enum.join(" ")

    "│   " <> colorize(header, @ansi_gray)
  end

  @spec running_table_separator_row(pos_integer()) :: String.t()
  def running_table_separator_row(running_event_width) do
    separator_width =
      @running_id_width +
        @running_stage_width +
        @running_pid_width +
        @running_age_width +
        @running_tokens_width +
        @running_session_width +
        running_event_width + 6

    "│   " <> colorize(String.duplicate("─", separator_width), @ansi_gray)
  end
end
