import { create } from "zustand";
import { persist } from "zustand/middleware";

type UiState = {
  debugMode: boolean;
  focusMode: boolean;
  toggleDebugMode: () => void;
  toggleFocusMode: () => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      debugMode: false,
      focusMode: false,
      toggleDebugMode: () => set((state) => ({ debugMode: !state.debugMode })),
      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
    }),
    {
      name: "harper-openclaw-ui",
      partialize: (state) => ({ debugMode: state.debugMode, focusMode: state.focusMode }),
    },
  ),
);
