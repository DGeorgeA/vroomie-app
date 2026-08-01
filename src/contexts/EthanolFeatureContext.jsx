/**
 * EthanolFeatureContext — single source of truth for the Ethanol Contamination
 * Check's global on/off state, resolved once per session.
 *
 * Design notes:
 *   * No polling. The flag is fetched on mount and after an admin toggle.
 *   * Fail-safe: any failure leaves `enabled === false`, so a backend problem
 *     degrades to "normal Vroomie" rather than breaking anything.
 *   * Consumers outside the provider get a safe default instead of throwing,
 *     which keeps the feature strictly optional.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { isFeatureEnabled, invalidateFeatureCache, FEATURE_ETHANOL_CHECK } from '@/services/featureFlagService';

const DEFAULT_STATE = { enabled: false, loading: false, refresh: async () => {} };
const EthanolFeatureContext = createContext(DEFAULT_STATE);

export function useEthanolFeature() {
  return useContext(EthanolFeatureContext) || DEFAULT_STATE;
}

export function EthanolFeatureProvider({ children }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    invalidateFeatureCache();
    try {
      setEnabled(await isFeatureEnabled(FEATURE_ETHANOL_CHECK));
    } catch {
      setEnabled(false); // fail-safe
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const on = await isFeatureEnabled(FEATURE_ETHANOL_CHECK);
        if (alive) setEnabled(on);
      } catch {
        if (alive) setEnabled(false);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <EthanolFeatureContext.Provider value={{ enabled, loading, refresh }}>
      {children}
    </EthanolFeatureContext.Provider>
  );
}
