type VortexLogoProps = {
  size?: number;
  className?: string;
  title?: string;
};

/**
 * Vortex Functions logo — a swirling vortex with a code chevron at its center.
 * Uses currentColor + theme tokens via inline gradients tied to --primary / --accent.
 */
export function VortexLogo({ size = 32, className, title = "Vortex Functions" }: VortexLogoProps) {
  const id = `vortex-grad-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="oklch(0.78 0.18 195)" />
          <stop offset="60%" stopColor="oklch(0.72 0.20 250)" />
          <stop offset="100%" stopColor="oklch(0.70 0.22 340)" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="oklch(0.85 0.20 190)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="oklch(0.85 0.20 190)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Outer glow */}
      <circle cx="32" cy="32" r="30" fill={`url(#${id}-glow)`} />

      {/* Vortex spiral — three nested arcs rotating around the center */}
      <g fill="none" stroke={`url(#${id})`} strokeWidth="3.5" strokeLinecap="round">
        <path d="M52 32 a20 20 0 1 0 -20 20" />
        <path d="M46 32 a14 14 0 1 1 -14 -14" />
        <path d="M40 32 a8 8 0 1 0 -8 8" />
      </g>

      {/* Center chevron — code mark */}
      <g stroke={`url(#${id})`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M28 28 L24 32 L28 36" />
        <path d="M36 28 L40 32 L36 36" />
      </g>
    </svg>
  );
}
