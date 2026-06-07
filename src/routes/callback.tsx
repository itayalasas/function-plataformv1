import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Loader2, XCircle } from "lucide-react";
import { exchangeCode } from "@/lib/auth/auth-system";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/callback")({
  component: CallbackPage,
});

function CallbackPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (!code || state !== "authenticated") {
      setError("Callback inválido. Vuelve a iniciar sesión.");
      return;
    }

    (async () => {
      try {
        await exchangeCode(code);
        refresh();
        navigate({ to: "/dashboard", replace: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo intercambiar el código");
      }
    })();
  }, [navigate, refresh]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-md text-center space-y-4">
        {error ? (
          <>
            <XCircle className="w-10 h-10 text-destructive mx-auto" />
            <h1 className="text-xl font-semibold">Error de autenticación</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => navigate({ to: "/login", replace: true })}>
              Volver a /login
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
            <h1 className="text-xl font-semibold">Autenticando…</h1>
            <p className="text-sm text-muted-foreground">
              Intercambiando código con AuthSystem.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
