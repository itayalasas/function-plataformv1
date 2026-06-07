import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/app")({
  component: () => <Navigate to="/dashboard" replace />,
});
