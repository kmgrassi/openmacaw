defmodule SymphonyElixir.Runner.ArtifactsTest do
  use SymphonyElixir.TestSupport, async: true

  alias SymphonyElixir.Runner.Artifacts

  defmodule RecordingUploader do
    @behaviour SymphonyElixir.Runner.Artifacts.Uploader

    @impl true
    def put_object(bucket, key, body, opts) do
      send(self(), {:put_object, bucket, key, body, opts})
      {:ok, %{"etag" => "test-etag"}}
    end
  end

  test "uploads summary, logs, final artifacts, and diagnostics to the owned S3 run prefix" do
    artifacts = [
      Artifacts.summary(%{"status" => "failed", "reason" => "clone_failed"}),
      Artifacts.command_log("git clone", "fatal: repository not found\n"),
      Artifacts.final_artifact("review.md", "# Review\n"),
      Artifacts.diagnostics(%{"materialization" => [%{"resource_id" => "repo-1", "status" => "failed"}]})
    ]

    assert {:ok, refs} =
             Artifacts.upload_many(
               %{sink: "s3://runtime-artifacts/cloud", workspace_id: "workspace-1", run_id: "run-1"},
               artifacts,
               uploader: RecordingUploader
             )

    assert length(refs) == 4

    assert Enum.map(refs, & &1["uri"]) == [
             "s3://runtime-artifacts/cloud/workspaces/workspace-1/runs/run-1/summary.json",
             "s3://runtime-artifacts/cloud/workspaces/workspace-1/runs/run-1/command-logs/git_clone.log",
             "s3://runtime-artifacts/cloud/workspaces/workspace-1/runs/run-1/final/review.md",
             "s3://runtime-artifacts/cloud/workspaces/workspace-1/runs/run-1/diagnostics.json"
           ]

    assert_received {:put_object, "runtime-artifacts", "cloud/workspaces/workspace-1/runs/run-1/summary.json", summary_body, [content_type: "application/json"]}
    assert Jason.decode!(summary_body) == %{"status" => "failed", "reason" => "clone_failed"}

    assert_received {:put_object, "runtime-artifacts", "cloud/workspaces/workspace-1/runs/run-1/command-logs/git_clone.log", "fatal: repository not found\n",
                     [content_type: "text/plain; charset=utf-8"]}

    assert_received {:put_object, "runtime-artifacts", "cloud/workspaces/workspace-1/runs/run-1/final/review.md", "# Review\n", [content_type: "text/plain; charset=utf-8"]}

    assert_received {:put_object, "runtime-artifacts", "cloud/workspaces/workspace-1/runs/run-1/diagnostics.json", diagnostics_body, [content_type: "application/json"]}
    assert Jason.decode!(diagnostics_body)["materialization"] == [%{"resource_id" => "repo-1", "status" => "failed"}]
  end

  test "rejects artifact names that would write outside the run prefix" do
    assert {:error, {:invalid_artifact_name, "../other-workspace/leak.json"}} =
             Artifacts.upload_many(
               %{sink: "s3://runtime-artifacts/cloud", workspace_id: "workspace-1", run_id: "run-1"},
               [%{name: "../other-workspace/leak.json", body: "nope"}],
               uploader: RecordingUploader
             )

    refute_received {:put_object, _bucket, _key, _body, _opts}
  end

  test "rejects workspace and run ids that cannot be safe prefix segments" do
    assert {:error, {:invalid_artifact_segment, "../workspace-2"}} =
             Artifacts.upload_many(
               %{sink: "s3://runtime-artifacts/cloud", workspace_id: "../workspace-2", run_id: "run-1"},
               [Artifacts.summary(%{})],
               uploader: RecordingUploader
             )

    assert {:error, {:invalid_artifact_segment, "workspace-1/run-2"}} =
             Artifacts.upload_many(
               %{sink: "s3://runtime-artifacts/cloud", workspace_id: "workspace-1/run-2", run_id: "run-1"},
               [Artifacts.summary(%{})],
               uploader: RecordingUploader
             )
  end

  test "uploads to a local artifact sink with the same run prefix contract" do
    root = tmp_dir!("runtime-artifacts")

    assert {:ok, [%{"path" => path, "uri" => path}]} =
             Artifacts.upload_many(
               %{sink: root, workspace_id: "workspace-1", run_id: "run-1"},
               [Artifacts.command_log("cmd-1", "ok\n")]
             )

    assert path == Path.join([root, "workspaces", "workspace-1", "runs", "run-1", "command-logs", "cmd-1.log"])
    assert File.read!(path) == "ok\n"
  end
end
