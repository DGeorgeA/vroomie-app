import React, { useState, useCallback } from "react";

/**
 * VroomieLogo — Real mascot image with premium micro-interaction.
 *
 * Click behaviour:
 *   1. Glow pulse radiates outward (300ms)
 *   2. Scale springs to 1.05x then returns
 *   3. After animation, navigates to home (page reload)
 *
 * No framer-motion. Pure CSS keyframes. <2KB overhead.
 */
export default function VroomieLogo({ size = "md", onClick }) {
  const [pulsing, setPulsing] = useState(false);

  const sizes = {
    sm: 32,
    md: 44,
    lg: 64,
    xl: 96,
  };

  const px = sizes[size] || sizes.md;

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
    }, 420);
  }, [pulsing, onClick]);

  return (
    <>
      <style>{`
        @keyframes vroomie-pulse {
          0%   { transform: scale(1);    filter: drop-shadow(0 0 0px rgba(252,211,77,0)); }
          35%  { transform: scale(1.05); filter: drop-shadow(0 0 10px rgba(252,211,77,0.75)) drop-shadow(0 0 22px rgba(245,158,11,0.4)); }
          70%  { transform: scale(1.02); filter: drop-shadow(0 0 5px rgba(252,211,77,0.4)); }
          100% { transform: scale(1);    filter: drop-shadow(0 0 0px rgba(252,211,77,0)); }
        }
        .vroomie-logo-wrap {
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          border-radius: 50%;
          position: relative;
          transition: filter 0.2s ease;
          -webkit-tap-highlight-color: transparent;
          user-select: none;
        }
        .vroomie-logo-wrap:hover img {
          filter: drop-shadow(0 0 6px rgba(252,211,77,0.55));
        }
        .vroomie-logo-wrap.pulsing img {
          animation: vroomie-pulse 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
          pointer-events: none;
        }
        .vroomie-logo-img {
          display: block;
          object-fit: contain;
          will-change: transform, filter;
          /* Drop shadow sits around the actual transparent logo */
          filter: drop-shadow(0 2px 6px rgba(0,0,0,0.55));
          transition: filter 0.2s ease;
        }
      `}</style>

      <div
        className={`vroomie-logo-wrap${pulsing ? " pulsing" : ""}`}
        onClick={handleClick}
        style={{ width: px, height: px }}
        role="button"
        aria-label="Vroomie — go to home"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && handleClick()}
      >
        <img
          src="/vroomie-logo.png"
          alt="Vroomie mascot"
          className="vroomie-logo-img"
          width={px}
          height={px}
          draggable={false}
        />
      </div>
    </>
  );
}