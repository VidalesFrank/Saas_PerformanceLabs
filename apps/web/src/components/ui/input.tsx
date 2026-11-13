import { InputHTMLAttributes, forwardRef, LabelHTMLAttributes } from "react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input
      ref={ref}
      className={
        "w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2 text-sm text-text " +
        "placeholder:text-text-muted/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] " +
        "transition-[border-color,box-shadow,background] duration-150 " +
        "hover:border-[color-mix(in_srgb,var(--tech-cyan)_35%,var(--color-border))] " +
        "focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--tech-cyan)_45%,transparent)] " +
        "focus:border-[var(--tech-cyan)] focus:bg-surface " +
        `${className}`
      }
      {...props}
    />
  )
);
Input.displayName = "Input";

export function Label({ className = "", ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={
        "mb-1.5 block text-[10.5px] font-bold uppercase tracking-[0.1em] text-text-muted " +
        `${className}`
      }
      {...props}
    />
  );
}
