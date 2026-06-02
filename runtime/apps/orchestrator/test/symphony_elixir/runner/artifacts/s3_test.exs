defmodule SymphonyElixir.Runner.Artifacts.S3Test do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.Runner.Artifacts.S3

  setup do
    # Scrub any ambient AWS env so we exercise explicit credential paths.
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

  describe "SigV4 canonical URI" do
    test "virtual-hosted-style signs canonical URI as /<key>" do
      test_pid = self()

      plug = fn conn ->
        send(
          test_pid,
          {:s3_request, conn.request_path, Plug.Conn.get_req_header(conn, "authorization"),
           Plug.Conn.get_req_header(conn, "host")}
        )

        conn
        |> Plug.Conn.put_resp_header("etag", "\"virtual-etag\"")
        |> Plug.Conn.send_resp(200, "")
      end

      assert {:ok, %{"etag" => "\"virtual-etag\""}} =
               S3.put_object("my-bucket", "runs/abc/summary.json", "body",
                 region: "us-east-2",
                 access_key_id: "AKIDEXAMPLE",
                 secret_access_key: "SECRET",
                 req_options: [plug: plug]
               )

      assert_receive {:s3_request, "/runs/abc/summary.json", [auth], _host}
      # The canonical URI is embedded in the signature; the SignedHeaders set
      # should not include any bucket-prefix bookkeeping.
      assert auth =~ "AWS4-HMAC-SHA256"
      assert auth =~ "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"
    end

    test "path-style (custom endpoint) signs canonical URI as /<bucket>/<key>" do
      test_pid = self()

      plug = fn conn ->
        send(
          test_pid,
          {:s3_request, conn.request_path, Plug.Conn.get_req_header(conn, "authorization")}
        )

        conn
        |> Plug.Conn.put_resp_header("etag", "\"path-etag\"")
        |> Plug.Conn.send_resp(200, "")
      end

      assert {:ok, %{"etag" => "\"path-etag\""}} =
               S3.put_object("my-bucket", "runs/abc/summary.json", "body",
                 region: "us-east-2",
                 access_key_id: "AKIDEXAMPLE",
                 secret_access_key: "SECRET",
                 endpoint: "http://minio.test:9000",
                 req_options: [plug: plug]
               )

      # The request URL is built as /<bucket>/<key>; the SigV4 canonical URI
      # must match exactly, otherwise S3-compatible endpoints reject the
      # signature.
      assert_receive {:s3_request, "/my-bucket/runs/abc/summary.json", [_auth]}
    end
  end

  describe "ECS task-role credentials" do
    test "fetches credentials from AWS_CONTAINER_CREDENTIALS_RELATIVE_URI and forwards session token" do
      test_pid = self()

      ecs_plug = fn conn ->
        send(test_pid, {:ecs_request, conn.host, conn.request_path})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(
          200,
          Jason.encode!(%{
            "AccessKeyId" => "ASIAECS",
            "SecretAccessKey" => "ecs-secret",
            "Token" => "ecs-session-token",
            "Expiration" => "2099-01-01T00:00:00Z"
          })
        )
      end

      s3_plug = fn conn ->
        token = Plug.Conn.get_req_header(conn, "x-amz-security-token")
        authorization = Plug.Conn.get_req_header(conn, "authorization")
        send(test_pid, {:s3_request, conn.request_path, token, authorization})

        conn
        |> Plug.Conn.put_resp_header("etag", "\"ecs-etag\"")
        |> Plug.Conn.send_resp(200, "")
      end

      put_system_env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/abc-token")

      assert {:ok, %{"etag" => "\"ecs-etag\""}} =
               S3.put_object("bucket-1", "key/path", "payload",
                 region: "us-east-1",
                 req_options: [plug: s3_plug],
                 ecs_credentials_req_options: [plug: ecs_plug]
               )

      assert_receive {:ecs_request, "169.254.170.2", "/v2/credentials/abc-token"}
      assert_receive {:s3_request, "/key/path", ["ecs-session-token"], [auth]}
      # Authorization header must reference the ECS access key.
      assert auth =~ "Credential=ASIAECS/"
      # SignedHeaders must include x-amz-security-token when a token is set.
      assert auth =~ "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
    end

    test "uses AWS_CONTAINER_CREDENTIALS_FULL_URI when relative URI is unset" do
      test_pid = self()

      ecs_plug = fn conn ->
        send(test_pid, {:ecs_request, conn.host, conn.request_path})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(
          200,
          Jason.encode!(%{
            "AccessKeyId" => "ASIAFULL",
            "SecretAccessKey" => "full-secret",
            "Token" => "full-token"
          })
        )
      end

      s3_plug = fn conn ->
        conn
        |> Plug.Conn.put_resp_header("etag", "\"full-etag\"")
        |> Plug.Conn.send_resp(200, "")
      end

      put_system_env(
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "http://credentials.local:8080/role"
      )

      assert {:ok, %{"etag" => "\"full-etag\""}} =
               S3.put_object("bucket-1", "key/path", "payload",
                 region: "us-east-1",
                 req_options: [plug: s3_plug],
                 ecs_credentials_req_options: [plug: ecs_plug]
               )

      assert_receive {:ecs_request, "credentials.local", "/role"}
    end

    test "static AWS_ACCESS_KEY_ID still wins over ECS endpoint" do
      put_system_env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/should-not-be-called")
      put_system_env("AWS_ACCESS_KEY_ID", "AKIDSTATIC")
      put_system_env("AWS_SECRET_ACCESS_KEY", "STATIC")

      s3_plug = fn conn ->
        conn
        |> Plug.Conn.put_resp_header("etag", "\"static-etag\"")
        |> Plug.Conn.send_resp(200, "")
      end

      # If ECS were called, it would fail because no stub is provided.
      assert {:ok, %{"etag" => "\"static-etag\""}} =
               S3.put_object("bucket-1", "key", "payload",
                 region: "us-east-1",
                 req_options: [plug: s3_plug]
               )
    end

    test "missing static creds and missing ECS env returns :missing_aws_config" do
      assert {:error, {:missing_aws_config, :access_key_id}} =
               S3.put_object("bucket-1", "key", "payload", region: "us-east-1")
    end
  end
end
