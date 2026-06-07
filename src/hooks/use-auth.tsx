import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  loadAuthConfig,
  getAccessToken,
  getUserFromToken,
  clearTokens,
  redirectToLogin,
  redirectToRegister,
  type AuthSystemUser,
} from "@/lib/auth/auth-system";

interface AuthCtx {
  user: AuthSystemUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
  signIn: () => Promise<void>;
  signUp: () => Promise<void>;
  refresh: () => void;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  loading: true,
  signOut: async () => {},
  signIn: async () => {},
  signUp: async () => {},
  refresh: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthSystemUser | null>(null);
  const [loading, setLoading] = useState(true);

  const hydrate = useCallback(() => {
    const token = getAccessToken();
    setUser(getUserFromToken(token));
  }, []);

  useEffect(() => {
    // Preload AuthSystem config so login/register redirects are instant.
    loadAuthConfig().catch((e) => console.warn("[auth] config load failed", e));
    hydrate();
    setLoading(false);

    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith("authsystem:")) hydrate();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hydrate]);

  return (
    <Ctx.Provider
      value={{
        user,
        loading,
        signOut: async () => {
          clearTokens();
          setUser(null);
          window.location.href = "/login";
        },
        signIn: redirectToLogin,
        signUp: redirectToRegister,
        refresh: hydrate,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
