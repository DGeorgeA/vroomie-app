import React, { useState, useCallback } from "react";

/**
 * VroomieLogo — Premium flat SVG with micro-interaction.
 * Click → soft glow pulse + 1.05x scale (300ms), then reloads page.
 * No persistent animation. Lightweight. Zero external deps.
 */
export default function VroomieLogo({ size = "md", onClick }) {
  const [pulsing, setPulsing] = useState(false);

  const sizes = {
    sm: { w: 28, h: 18 },
    md: { w: 40, h: 25 },
    lg: { w: 56, h: 35 },
    xl: { w: 88, h: 55 },
  };

  const { w, h } = sizes[size] || sizes.md;

  const handleClick = useCallback(() => {
    if (pulsing) return;
    setPulsing(true);
    setTimeout(() => {
      setPulsing(false);
      if (onClick) {
        onClick();
      } else {
        window.location.href = "/";
      }
    }, 380);
  }, [pulsing, onClick]);

  return (
    <>
      <style>{`
        @keyframes vroomie-glow-pulse {
          0%   { filter: drop-shadow(0 0 0px #FCD34D); transform: scale(1); }
          40%  { filter: drop-shadow(0 0 8px #FCD34D) drop-shadow(0 0 16px #F59E0B66); transform: scale(1.05); }
          100% { filter: drop-shadow(0 0 0px #FCD34D); transform: scale(1); }
        }
        .vroomie-logo-svg {
          cursor: pointer;
          display: block;
          flex-shrink: 0;
          transition: filter 0.15s ease;
          will-change: transform, filter;
        }
        .vroomie-logo-svg:hover {
          filter: drop-shadow(0 0 4px #FCD34D88);
        }
        .vroomie-logo-svg.pulsing {
          animation: vroomie-glow-pulse 0.38s ease-out forwards;
          pointer-events: none;
        }
      `}</style>
      <svg
        width={w}
        height={h}
        viewBox="0 0 64 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        onClick={handleClick}
        className={`vroomie-logo-svg${pulsing ? " pulsing" : ""}`}
        aria-label="Vroomie — tap to go home"
        role="img"
      >
        {/* Car body */}
        <path
          d="M6 28 C6 28 4 28 4 26 L4 22 C4 22 4 20 6 20 L10 20 L15 12 C15 12 17 10 20 10 L44 10 C47 10 49 12 49 12 L54 20 L58 20 C60 20 60 22 60 22 L60 26 C60 28 58 28 58 28 L6 28 Z"
          fill="#FCD34D"
        />
        {/* Roof highlight — depth */}
        <path
          d="M20.5 10.5 L15.5 19.5 L48.5 19.5 L53.5 10.5 Z"
          fill="#FDE68A"
          opacity="0.35"
        />
        {/* Windshield */}
        <path
          d="M21 20 L24 13 L42 13 L46 20 Z"
          fill="#0a0a0a"
          opacity="0.60"
        />
        {/* Left wheel */}
        <circle cx="17" cy="29" r="6.5" fill="#18181b" />
        <circle cx="17" cy="29" r="3.5" fill="#3f3f46" />
        <circle cx="17" cy="29" r="1.5" fill="#52525b" />
        {/* Right wheel */}
        <circle cx="47" cy="29" r="6.5" fill="#18181b" />
        <circle cx="47" cy="29" r="3.5" fill="#3f3f46" />
        <circle cx="47" cy="29" r="1.5" fill="#52525b" />
        {/* Headlight */}
        <rect x="55" y="21" width="4" height="3.5" rx="1.5" fill="#FEF9C3" opacity="0.95" />
        {/* Headlight inner glow */}
        <rect x="56" y="21.5" width="2" height="2" rx="1" fill="white" opacity="0.7" />
        {/* Tail light */}
        <rect x="5" y="21" width="4" height="3.5" rx="1.5" fill="#FCA5A5" opacity="0.9" />
        {/* Stethoscope earpiece — subtle nod to diagnostic branding */}
        <circle cx="54" cy="14" r="2" fill="none" stroke="#FCD34D" strokeWidth="1.2" opacity="0.7" />
        <line x1="54" y1="16" x2="54" y2="19" stroke="#FCD34D" strokeWidth="1" opacity="0.6" />
      </svg>
    </>
  );
}