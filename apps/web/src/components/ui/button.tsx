import { ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

/* Variantes:
 * - primary  : gradient cyan→blue, sombra con glow. Para CTAs principales.
 * - secondary: outline sutil sobre surface-2. Para acciones secundarias.
 * - ghost    : sin fondo, hover suave. Para acciones terciarias (cancelar, etc).
 * - danger   : rojo plano para acciones destructivas.
 */

const variantClasses: Record<Variant, string> = {
  primary:
    "text-white shadow-[0_6px_18px_-8px_rgba(34,211,238,0.55),inset_0_1px_0_rgba(255,255,255,0.22)] " +
    "hover:shadow-[0_10px_26px_-10px_rgba(34,211,238,0.7),inset_0_1px_0_rgba(255,255,255,0.28)] " +
    "hover:brightness-[1.05] active:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed " +
    "disabled:shadow-none",
  secondary:
    "bg-surface-2 text-text border border-border " +
    "hover:border-[color-mix(in_srgb,var(--tech-cyan)_50%,var(--color-border))] hover:bg-surface " +
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ghost:
    "text-text-muted hover:text-text hover:bg-surface-2 " +
    "disabled:opacity-50 disabled:cursor-not-allowed",
  danger:
    "bg-danger text-white hover:brightness-110 active:brightness-95 " +
    "shadow-[0_4px_14px_-6px_rgba(200,30,58,0.45)] disabled:opacity-50 disabled:cursor-not-allowed",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs rounded-md",
  md: "px-4 py-2 text-sm rounded-md",
  lg: "px-5 py-2.5 text-[14.5px] rounded-lg",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant = "primary", size = "md", style, ...props }, ref) => {
    const primaryStyle =
      variant === "primary"
        ? { background: "linear-gradient(135deg, #22d3ee 0%, #3b82f6 100%)", ...style }
        : style;

    return (
      <button
        ref={ref}
        style={primaryStyle}
        className={
          "inline-flex items-center justify-center gap-2 font-medium tracking-[-0.005em] " +
          "transition-[background,box-shadow,border-color,color,filter,transform] duration-150 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tech-cyan)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] " +
          `${sizeClasses[size]} ${variantClasses[variant]} ${className}`
        }
        {...props}
      />
    );
  }
);
Button.displayName = "Button";
