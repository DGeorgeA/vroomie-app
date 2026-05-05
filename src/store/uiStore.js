import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useUIStore = create(
  persist(
    (set) => ({
      // CRITICAL: Default to CLOSED. Sidebar must be hidden by default,
      // especially on mobile where an open sidebar covers the entire screen.
      isSidebarCollapsed: true,
      toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
      setSidebarCollapsed: (value) => set({ isSidebarCollapsed: value }),
    }),
    {
      // Bumped key to 'v2' so any old persisted 'false' state is discarded on load
      name: 'vroomie-ui-v2',
    }
  )
);
