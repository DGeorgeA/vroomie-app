import React, { useState, useCallback } from "react";
import { useEthanolFeature } from "@/contexts/EthanolFeatureContext";

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
  // Golden ethanol sash — a pure OVERLAY. The original logo asset is never
  // modified, so when the feature is disabled the mark renders exactly as
  // before with no layout or spacing residue.
  const { enabled: ethanolEnabled } = useEthanolFeature();

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
        /* ── Ethanol golden sash (overlay only — removable with zero residue) ── */
        .vroomie-sash {
          position: absolute;
          left: 50%;
          bottom: 4%;
          transform: translateX(-50%) rotate(-14deg);
          transform-origin: center;
          pointer-events: none;
          white-space: nowrap;
          border-radius: 2px;
          background: linear-gradient(180deg, #fde68a 0%, #f2c14a 38%, #c8901d 72%, #8a5f0d 100%);
          box-shadow: 0 1px 3px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.6);
          border-top: 1px solid rgba(255,255,255,0.5);
          color: #4a2f05;
          font-weight: 800;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          line-height: 1;
          text-align: center;
          overflow: hidden;
        }
        .vroomie-sash::after {
          /* restrained metallic sheen */
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,0.55) 50%, transparent 65%);
        }
        @media (prefers-reduced-motion: reduce) {
          .vroomie-logo-wrap.pulsing img { animation: none; }
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
        {ethanolEnabled && (
          <span
            className="vroomie-sash"
            aria-hidden="true"
            style={{
              // Scales with the mark; text only where it stays legible.
              fontSize: Math.max(4, Math.round(px * 0.105)),
              padding: `${Math.max(1, Math.round(px * 0.035))}px ${Math.max(2, Math.round(px * 0.09))}px`,
              maxWidth: px * 1.28,
            }}
          >
            {px >= 64 ? 'Ethanol Check' : px >= 40 ? 'Ethanol' : 'E'}
          </span>
        )}
      </div>
    </>
  );
}