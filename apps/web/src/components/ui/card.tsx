import { HTMLAttributes } from "react";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={
        "rounded-xl border border-border bg-surface " +
        "shadow-[0_1px_3px_rgba(15,23,42,0.04),0_2px_12px_-6px_rgba(15,23,42,0.06)] " +
        "transition-[box-shadow,border-color] duration-200 " +
        `${className}`
      }
      {...props}
    />
  );
}

export function CardHeader({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 py-4 border-b border-border ${className}`} {...props} />;
}

export function CardBody({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-5 ${className}`} {...props} />;
}
