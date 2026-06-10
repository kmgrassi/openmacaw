defmodule SymphonyElixir.StructuredContext do
  @moduledoc """
  Formats structured runtime records into chat-ready context.

  Callers get both the body that should be sent to a model and metadata that
  can ride alongside the persisted user message.
  """

  alias SymphonyElixir.WorkItem

  @type format_kind :: String.t() | atom()
  @type format_opts :: [
          kind: format_kind(),
          note: String.t()
        ]

  @doc """
  Render work items as a JSON chat payload and structured metadata.
  """
  @spec format_work_items([WorkItem.t()], format_opts()) :: {String.t(), map()}
  def format_work_items(work_items, opts \\ []) when is_list(work_items) and is_list(opts) do
    kind = normalize_kind(Keyword.get(opts, :kind, "due_tasks"))
    note = Keyword.get(opts, :note)
    work_item_payloads = Enum.map(work_items, &work_item_payload/1)

    body =
      %{kind => work_item_payloads}
      |> maybe_put_note(note)
      |> Jason.encode!()

    metadata =
      %{
        "kind" => kind,
        "work_item_ids" => Enum.map(work_items, & &1.id)
      }
      |> maybe_put_note(note)

    {body, metadata}
  end

  @spec work_item_payload(WorkItem.t()) :: map()
  def work_item_payload(%WorkItem{} = item) do
    %{
      "id" => item.id,
      "identifier" => item.identifier,
      "title" => item.title,
      "description" => item.description,
      "state" => item.state,
      "url" => item.url,
      "metadata" => item.metadata
    }
  end

  defp normalize_kind(kind) when is_atom(kind), do: Atom.to_string(kind)
  defp normalize_kind(kind) when is_binary(kind), do: kind

  defp maybe_put_note(map, note) when is_binary(note) and note != "" do
    Map.put(map, "note", note)
  end

  defp maybe_put_note(map, _note), do: map
end
