defmodule SymphonyElixir.Orchestrator.WorkerSlotReservations do
  @moduledoc """
  In-node reservation registry for reusable worker slots.

  The orchestrator reserves a slot before spawning a task so concurrent
  dispatchers on the same BEAM node cannot over-allocate the same warm worker.
  """

  use GenServer

  alias SymphonyElixir.Orchestrator.WorkerSlotPolicy
  alias SymphonyElixir.Orchestrator.WorkerSlotPolicy.{Request, Slot}

  defmodule Reservation do
    @moduledoc false

    @enforce_keys [:id, :slot_id, :reserved_at]
    defstruct [
      :id,
      :slot_id,
      :owner,
      :workspace_id,
      :customer_id,
      :runner_kind,
      :reserved_at,
      required_credential_ids: [],
      required_resource_ids: []
    ]
  end

  defmodule State do
    @moduledoc false

    defstruct reservations: %{}
  end

  @type server :: GenServer.server()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @spec reserve(server(), Slot.t(), Request.t(), term(), keyword()) ::
          {:ok, Reservation.t()} | {:error, term()}
  def reserve(server \\ __MODULE__, %Slot{} = slot, %Request{} = request, owner, opts \\ []) do
    GenServer.call(server, {:reserve, slot, request, owner, now_from(opts)})
  end

  @spec release(server(), Reservation.t() | String.t() | nil) :: :ok
  def release(server \\ __MODULE__, reservation)
  def release(_server, nil), do: :ok

  def release(server, %Reservation{id: id}), do: release(server, id)

  def release(server, reservation_id) when is_binary(reservation_id) do
    GenServer.call(server, {:release, reservation_id})
  end

  @spec reserved_count(server(), String.t()) :: non_neg_integer()
  def reserved_count(server \\ __MODULE__, slot_id) when is_binary(slot_id) do
    GenServer.call(server, {:reserved_count, slot_id})
  end

  @spec list(server()) :: [Reservation.t()]
  def list(server \\ __MODULE__) do
    GenServer.call(server, :list)
  end

  @impl true
  def init(_opts), do: {:ok, %State{}}

  @impl true
  def handle_call({:reserve, %Slot{} = slot, %Request{} = request, owner, now}, _from, %State{} = state) do
    existing = Map.get(state.reservations, slot.id, %{})

    slot_with_reservations = %{
      slot
      | active_session_count: count(slot.active_session_count) + map_size(existing)
    }

    with :ok <- reject_existing_boundary_conflict(existing, request),
         :ok <- WorkerSlotPolicy.reusable?(slot_with_reservations, request) do
      reservation = new_reservation(slot, request, owner, now)
      reservations = Map.put(existing, reservation.id, reservation)
      state = %{state | reservations: Map.put(state.reservations, slot.id, reservations)}

      {:reply, {:ok, reservation}, state}
    else
      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:release, reservation_id}, _from, %State{} = state) do
    {:reply, :ok, %{state | reservations: release_reservation(state.reservations, reservation_id)}}
  end

  def handle_call({:reserved_count, slot_id}, _from, %State{} = state) do
    {:reply, state.reservations |> Map.get(slot_id, %{}) |> map_size(), state}
  end

  def handle_call(:list, _from, %State{} = state) do
    reservations =
      state.reservations
      |> Map.values()
      |> Enum.flat_map(&Map.values/1)
      |> Enum.sort_by(&{&1.slot_id, &1.id})

    {:reply, reservations, state}
  end

  defp reject_existing_boundary_conflict(existing, %Request{} = request) do
    existing
    |> Map.values()
    |> Enum.find_value(:ok, fn reservation ->
      cond do
        boundary_mismatch?(reservation.workspace_id, request.workspace_id) ->
          {:error, :workspace_boundary_mismatch}

        boundary_mismatch?(reservation.customer_id, request.customer_id) ->
          {:error, :customer_boundary_mismatch}

        true ->
          false
      end
    end)
  end

  defp release_reservation(reservations_by_slot, reservation_id) do
    Enum.reduce(reservations_by_slot, %{}, fn {slot_id, reservations}, acc ->
      reservations = Map.delete(reservations, reservation_id)

      if map_size(reservations) == 0 do
        acc
      else
        Map.put(acc, slot_id, reservations)
      end
    end)
  end

  defp new_reservation(%Slot{} = slot, %Request{} = request, owner, now) do
    %Reservation{
      id: "slot-reservation-" <> Base.encode16(:crypto.strong_rand_bytes(12), case: :lower),
      slot_id: slot.id,
      owner: inspect(owner),
      workspace_id: request.workspace_id,
      customer_id: request.customer_id,
      runner_kind: request.runner_kind,
      required_credential_ids: request.required_credential_ids,
      required_resource_ids: request.required_resource_ids,
      reserved_at: now
    }
  end

  defp boundary_mismatch?(left, right) do
    present?(left) and present?(right) and left != right
  end

  defp now_from(opts) do
    case Keyword.get(opts || [], :now) do
      %DateTime{} = now -> now
      _ -> DateTime.utc_now()
    end
  end

  defp count(value) when is_integer(value) and value > 0, do: value
  defp count(_value), do: 0

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false
end
