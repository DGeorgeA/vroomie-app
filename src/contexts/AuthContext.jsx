import React, { createContext, useContext, useState, useEffect } from 'react';
import { onAuthStateChange, getCurrentUser } from '../services/authService';
import { isProUser, getSubscription } from '../services/subscriptionService';
import { setProStatus } from '../lib/featureGate';

const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isPro, setIsPro] = useState(false);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);

  async function refreshSubscription(userId) {
    if (!userId) {
      setIsPro(false);
      setProStatus(false);
      setSubscription(null);
      return;
    }
    
    try {
      const pro = await isProUser(userId);
      const sub = await getSubscription(userId);
      setIsPro(pro);
      setProStatus(pro);
      setSubscription(sub);
    } catch (err) {
      console.error('Subscription check failed:', err);
      setIsPro(false);
      setProStatus(false);
    }
  }

  useEffect(() => {
    // Check initial session
    getCurrentUser().then(async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        await refreshSubscription(currentUser.id);
      }
      setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription: authSub } } = onAuthStateChange(async (event, session) => {
      const sessionUser = session?.user || null;
      setUser(sessionUser);
      
      if (sessionUser) {
        await refreshSubscription(sessionUser.id);
      } else {
        setIsPro(false);
        setProStatus(false);
        setSubscription(null);
      }
    });

    return () => {
      authSub?.unsubscribe();
    };
  }, []);

  const value = {
    user,
    isPro,
    subscription,
    loading,
    refreshSubscription: () => user ? refreshSubscription(user.id) : Promise.resolve()
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
