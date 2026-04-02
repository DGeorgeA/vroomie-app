import React from "react";

/**
 * VroomieLogo — Clean, flat, minimal SVG car icon.
 * Static only. No animations. Scalable. Clicking reloads the page.
 */
export default function VroomieLogo({ size = "md", onClick }) {
  const sizes = {
    sm: 28,
    md: 36,
    lg: 52,
    xl: 80,
  };

  const px = sizes[size] || sizes.md;

  const handleClick = onClick || (() => { window.location.href = "/"; });

  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 64 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      onClick={handleClick}
      style={{ cursor: "pointer", display: "block", flexShrink: 0 }}
      aria-label="Vroomie — go to home"
      role="img"
    >
      {/* Car body */}
      <path
        d="M6 28 C6 28 4 28 4 26 L4 22 C4 22 4 20 6 20 L10 20 L15 12 C15 12 17 10 20 10 L44 10 C47 10 49 12 49 12 L54 20 L58 20 C60 20 60 22 60 22 L60 26 C60 28 58 28 58 28 L6 28 Z"
        fill="#FCD34D"
      />
      {/* Windshield */}
      <path
        d="M19 20 L22 13 L42 13 L46 20 Z"
        fill="#0a0a0a"
        opacity="0.55"
      />
      {/* Left wheel */}
      <circle cx="17" cy="28" r="6" fill="#18181b" />
      <circle cx="17" cy="28" r="3" fill="#3f3f46" />
      {/* Right wheel */}
      <circle cx="47" cy="28" r="6" fill="#18181b" />
      <circle cx="47" cy="28" r="3" fill="#3f3f46" />
      {/* Headlight */}
      <rect x="55" y="21" width="4" height="3" rx="1" fill="#FEF9C3" opacity="0.9" />
      {/* Tail light */}
      <rect x="5" y="21" width="4" height="3" rx="1" fill="#F87171" opacity="0.8" />
    </svg>
  );
}