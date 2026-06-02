import { create } from "zustand";

type GatewayState = {
  connected: boolean;
  setConnected: (connected: boolean) => void;
};

export const useGatewayStore = create<GatewayState>((set) => ({
  connected: false,
  setConnected: (connected) => set({ connected }),
}));
