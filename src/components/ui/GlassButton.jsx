import React from "react";
import { cn } from "@/lib/utils";

/**
 * GlassButton — Canonical button system.
 * Variants: primary (yellow CTA), secondary (ghost outline), danger (red destructive)
 */
export default function GlassButton({
  children,
  variant = "primary",
  size = "md",
  className = "",
  icon: Icon,
  ...props
}) {
  const variants = {
    primary:
      "bg-yellow-400 text-black hover:bg-yellow-300 active:bg-yellow-500 font-semibold",
    secondary:
      "bg-transparent border border-white/15 text-zinc-300 hover:bg-white/8 hover:border-white/25 font-medium",
    danger:
      "bg-red-500/90 text-white hover:bg-red-400 active:bg-red-600 font-semibold",
  };

  const sizes = {
    sm: "px-3.5 py-1.5 text-xs rounded-lg",
    md: "px-5 py-2.5 text-sm rounded-lg",
    lg: "px-7 py-3.5 text-base rounded-xl",
  };

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
      {children}
    </button>
  );
}