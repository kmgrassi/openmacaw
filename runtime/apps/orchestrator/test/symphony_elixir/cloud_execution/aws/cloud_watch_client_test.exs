defmodule SymphonyElixir.CloudExecution.Aws.CloudWatchClientTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.CloudExecution.Aws.CloudWatchClient

  setup do
    for key <- [
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SESSION_TOKEN",
          "AWS_REGION",
          "AWS_DEFAULT_REGION",
          "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
          "AWS_CONTAINER_CREDENTIALS_FULL_URI"
        ] do
      delete_system_env(key)
    end

    :ok
  end

  test "falls back to AWS_REGION when caller passes region nil" do
    test_pid = self()

    plug = fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:cloudwatch_request, conn.host, body, Plug.Conn.get_req_header(conn, "authorization")})

      Plug.Conn.send_resp(conn, 200, "")
    end

    put_system_env("AWS_REGION", "us-west-2")
    put_system_env("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE")
    put_system_env("AWS_SECRET_ACCESS_KEY", "SECRET")

    assert :ok =
             CloudWatchClient.put_metric_data(
               "OpenMacaw/dev/container-execution",
               [
                 %{
                   name: "SmokeTestFailed",
                   value: 0,
                   dimensions: %{"TestName" => "task_launch"}
                 }
               ],
               region: nil,
               req_options: [plug: plug]
             )

    assert_receive {:cloudwatch_request, "monitoring.us-west-2.amazonaws.com", body, [auth]}
    assert body =~ "Action=PutMetricData"
    assert body =~ "MetricData.member.1.Dimensions.member.1.Value=task_launch"
    assert auth =~ "Credential=AKIDEXAMPLE/"
  end
end
