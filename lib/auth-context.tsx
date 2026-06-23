'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClientSession {
  phone: string; // e.g. "+995599123456"
  token: string; // random uuid stored in localStorage
}

interface AuthCtx {
  session:  ClientSession | null;
  login:    (phone: string, token: string) => void;
  logout:   () => void;
  loading:  boolean;
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

const KEY_PHONE = 'msb_client_phone';
const KEY_TOKEN = 'msb_client_token';

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ClientSession | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    const phone = localStorage.getItem(KEY_PHONE);
    const token = localStorage.getItem(KEY_TOKEN);
    if (phone && token) setSession({ phone, token });
    setLoading(false);
  }, []);

  const login = useCallback((phone: string, token: string) => {
    localStorage.setItem(KEY_PHONE, phone);
    localStorage.setItem(KEY_TOKEN, token);
    setSession({ phone, token });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(KEY_PHONE);
    localStorage.removeItem(KEY_TOKEN);
    setSession(null);
  }, []);

  return (
    <AuthContext.Provider value={{ session, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
