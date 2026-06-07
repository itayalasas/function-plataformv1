import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { LogIn, UserPlus, Loader2 } from "lucide-react";
import { VortexLogo } from "@/components/VortexLogo";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user, loading, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"login" | "register" | null>(null);

  useEffect(() => {
    if (!loading && user) navigate({ to: "/dashboard", replace: true });
  }, [loading, user, navigate]);

  const handle = async (kind: "login" | "register") => {
    setBusy(kind);
    try {
      if (kind === "login") await signIn();
      else await signUp();
    } catch (e) {
      setBusy(null);
      toast.error(e instanceof Error ? e.message : "No se pudo abrir AuthSystem");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-glow pointer-events-none" />
      <div className="relative z-10 w-full max-w-md">
        <Link to="/" className="flex items-center justify-center gap-2 mb-8">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center shadow-glow">
            <VortexLogo size={48} />
          </div>
          <span className="font-display font-bold text-2xl text-gradient">Vortex</span>
        </Link>

        <div className="rounded-2xl border border-border bg-card p-8 shadow-elevated space-y-4">
          <div>
            <h1 className="font-display text-2xl font-bold mb-1">Entra a Vortex</h1>
            <p className="text-sm text-muted-foreground">
              Autenticación gestionada por AuthSystem.
            </p>
          </div>

          <Button
            onClick={() => handle("login")}
            disabled={busy !== null}
            className="w-full gap-2"
          >
            {busy === "login" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <LogIn className="w-4 h-4" />
            )}
            Iniciar sesión
          </Button>

          <Button
            onClick={() => handle("register")}
            disabled={busy !== null}
            variant="outline"
            className="w-full gap-2"
          >
            {busy === "register" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <UserPlus className="w-4 h-4" />
            )}
            Crear cuenta
          </Button>

          <p className="text-xs text-muted-foreground text-center pt-2">
            Serás redirigido a AuthSystem y regresarás a esta app tras autenticarte.
          </p>
        </div>
      </div>
    </div>
  );
}
