import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Code2, Lock, Activity, ArrowRight, Terminal } from "lucide-react";
import { VortexLogo } from "@/components/VortexLogo";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Vortex Functions — Edge functions con sandbox real" },
      { name: "description", content: "Escribe, despliega y ejecuta funciones tipo edge con editor en vivo, secretos cifrados y logs. Sandbox real en el navegador." },
    ],
  }),
  component: Landing,
});

function Landing() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) navigate({ to: "/dashboard" });
  }, [loading, user, navigate]);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-glow pointer-events-none" />

      <header className="relative z-10 border-b border-border/50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <VortexLogo size={32} />
            <span className="font-display font-bold text-lg text-gradient">Vortex</span>
            <span className="text-xs px-2 py-0.5 rounded-full border border-primary/30 text-primary font-mono">functions</span>
          </Link>
          <nav className="flex items-center gap-3">
            <Link to="/login">
              <Button variant="ghost" size="sm">Iniciar sesión</Button>
            </Link>
            <Link to="/login">
              <Button size="sm" className="bg-gradient-primary text-primary-foreground hover:opacity-90 shadow-glow">
                Empezar gratis
              </Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative z-10">
        <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-surface/50 backdrop-blur text-xs font-mono mb-8">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            Sandbox v1.0 disponible
          </div>

          <h1 className="font-display text-5xl md:text-7xl font-bold tracking-tight mb-6">
            Edge functions con<br />
            <span className="text-gradient">superpoderes reales</span>
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
            Escribe TypeScript en el editor, guarda secretos cifrados, e invoca tu función al
            instante. Todo corre en un sandbox aislado — sin servidores que aprovisionar.
          </p>

          <div className="flex flex-wrap justify-center gap-3 mb-16">
            <Link to="/login">
              <Button size="lg" className="bg-gradient-primary text-primary-foreground hover:opacity-90 shadow-glow gap-2">
                Crear mi primera función <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="gap-2">
              <Terminal className="w-4 h-4" /> Ver ejemplos
            </Button>
          </div>

          {/* Code preview */}
          <div className="max-w-3xl mx-auto rounded-xl border border-border bg-card shadow-elevated overflow-hidden text-left">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-surface">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-destructive/70" />
                <div className="w-3 h-3 rounded-full bg-warning/70" />
                <div className="w-3 h-3 rounded-full bg-success/70" />
              </div>
              <span className="text-xs font-mono text-muted-foreground ml-2">hello-world.ts</span>
              <span className="ml-auto text-xs font-mono text-success">● deployed</span>
            </div>
            <pre className="p-6 text-sm font-mono leading-relaxed overflow-x-auto"><code>{`Deno.serve(async (req) => {
  const { name } = await req.json();
  const apiKey = Deno.env.get("API_KEY");

  return new Response(
    JSON.stringify({ hello: name, time: Date.now() }),
    { headers: { "content-type": "application/json" } }
  );
});`}</code></pre>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-6 py-20 grid md:grid-cols-3 gap-6">
          {[
            { icon: Code2, title: "Editor en vivo", desc: "Monaco con resaltado de TypeScript. Guarda versiones, vuelve atrás cuando rompas algo." },
            { icon: Lock, title: "Secretos cifrados", desc: "Guarda tus API keys por proyecto. Accede vía Deno.env.get(...) — nunca expuestos al cliente." },
            { icon: Activity, title: "Logs en tiempo real", desc: "Cada invocación queda registrada: request, response, console.log, errores y duración." },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="p-6 rounded-xl border border-border bg-card hover:border-primary/40 transition-colors">
              <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center mb-4">
                <Icon className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-display font-semibold text-lg mb-2">{title}</h3>
              <p className="text-sm text-muted-foreground">{desc}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="relative z-10 border-t border-border/50 py-8">
        <div className="max-w-6xl mx-auto px-6 text-center text-sm text-muted-foreground font-mono">
          Vortex Functions · construido con cariño
        </div>
      </footer>
    </div>
  );
}
