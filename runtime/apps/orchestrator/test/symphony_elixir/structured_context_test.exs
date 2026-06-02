defmodule SymphonyElixir.StructuredContextTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.StructuredContext
  alias SymphonyElixir.WorkItem

  test "formats due work items with the existing due_tasks body shape" do
    work_items = [
      %WorkItem{
        id: "wi-1",
        identifier: "MAN-1",
        title: "Check failed run",
        state: "todo",
        url: "https://example.test/work/wi-1",
        metadata: %{"priority" => "high"}
      }
    ]

    assert {body, metadata} = StructuredContext.format_work_items(work_items, kind: :due_tasks)

    assert %{
             "due_tasks" => [
               %{
                 "id" => "wi-1",
                 "identifier" => "MAN-1",
                 "title" => "Check failed run",
                 "state" => "todo",
                 "url" => "https://example.test/work/wi-1",
                 "metadata" => %{"priority" => "high"}
               }
             ]
           } = Jason.decode!(body)

    assert metadata == %{
             "kind" => "due_tasks",
             "work_item_ids" => ["wi-1"]
           }
  end

  test "formats archived work items under the requested kind" do
    work_items = [
      %WorkItem{id: "wi-archived", title: "Archive follow-up", state: "done"}
    ]

    assert {body, metadata} = StructuredContext.format_work_items(work_items, kind: :archived_tasks)

    assert %{"archived_tasks" => [%{"id" => "wi-archived", "title" => "Archive follow-up"}]} =
             Jason.decode!(body)

    assert metadata["kind"] == "archived_tasks"
    assert metadata["work_item_ids"] == ["wi-archived"]
  end

  test "formats selected work items and carries a note into body and metadata" do
    work_items = [
      %WorkItem{id: "wi-selected", identifier: "SEL-1", title: "Selected task"}
    ]

    assert {body, metadata} =
             StructuredContext.format_work_items(work_items,
               kind: "selected",
               note: "User selected this task for review."
             )

    assert %{
             "selected" => [%{"id" => "wi-selected", "identifier" => "SEL-1"}],
             "note" => "User selected this task for review."
           } = Jason.decode!(body)

    assert metadata == %{
             "kind" => "selected",
             "work_item_ids" => ["wi-selected"],
             "note" => "User selected this task for review."
           }
  end

  test "exposes work item payload formatting for callers that compose larger contexts" do
    assert %{
             "id" => "wi-1",
             "identifier" => nil,
             "title" => nil,
             "state" => nil,
             "url" => nil,
             "metadata" => %{}
           } = StructuredContext.work_item_payload(%WorkItem{id: "wi-1"})
  end
end
