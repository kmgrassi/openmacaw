import { create } from "zustand";

type AgentsState = {
  selectedId: string | null;

  reset: () => void;
  select: (id: string | null) => void;
};

export const useAgentsStore = create<AgentsState>((set) => ({
  selectedId: null,
  reset: () => {
    set({ selectedId: null });
  },
  select: (id) => set({ selectedId: id }),
}));
