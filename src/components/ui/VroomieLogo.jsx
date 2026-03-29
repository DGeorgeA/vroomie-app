import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import vroomieLogo from "@/assets/vroomie_logo.jpg";

export default function VroomieLogo({ size = "md", animate = false, showAnimation = true }) {
  const [isAnimating, setIsAnimating] = useState(showAnimation);

  // Auto-play animation on mount or when showAnimation changes
  useEffect(() => {
    if (showAnimation) {
      setIsAnimating(true);
      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 5000); // Longer animation for the new "revving" effect
      return () => clearTimeout(timer);
    }
  }, [showAnimation]);

  const sizes = {
    sm: { width: 44, height: 44 },
    md: { width: 64, height: 64 },
    lg: { width: 100, height: 100 },
    xl: { width: 160, height: 160 },
  };

  const { width, height } = sizes[size] || sizes.md;

  // Premium "Revving" Animation
  const revvingAnimation = {
    x: [0, -1, 1, -1, 1, 0],
    y: [0, -0.5, 0.5, -0.5, 0.5, 0],
    scale: [1, 1.02, 1],
    transition: {
      duration: 0.1,
      repeat: Infinity,
      ease: "linear"
    }
  };

  const initialAnimation = {
    initial: { x: -50, opacity: 0, scale: 0.8 },
    animate: { 
      x: 0, 
      opacity: 1, 
      scale: 1,
      transition: {
        type: "spring",
        damping: 12,
        stiffness: 100,
        duration: 0.8,
      }
    }
  };

  return (
    <div className="relative flex items-center justify-center" style={{ width, height }}>
      {/* Background Glow / AI Aura */}
      <div className="absolute inset-0 bg-cyan-500/10 blur-xl rounded-full scale-150 animate-pulse pointer-events-none" />
      
      <AnimatePresence mode="wait">
        <motion.div
           key={isAnimating ? "animating" : "static"}
           {...initialAnimation}
           animate={isAnimating ? {
             ...initialAnimation.animate,
             ...revvingAnimation
           } : initialAnimation.animate}
           className="relative z-10 w-full h-full overflow-hidden rounded-[22%] shadow-2xl border border-white/5"
           style={{
             // Using a mask to "trim" the background from the JPG as best as possible
             WebkitMaskImage: 'radial-gradient(circle at center, black 65%, transparent 100%)',
             maskImage: 'radial-gradient(circle at center, black 65%, transparent 100%)',
           }}
        >
          <img
            src={vroomieLogo}
            alt="Vroomie Premium Logo"
            className="w-full h-full object-cover select-none"
            style={{
              filter: 'brightness(1.1) contrast(1.1) saturate(1.2)',
            }}
          />
          
          {/* Diagnostic Shine Effect */}
          <motion.div
            initial={{ left: '-100%' }}
            animate={{ left: '100%' }}
            transition={{
              duration: 2,
              repeat: Infinity,
              repeatDelay: 3,
              ease: "easeInOut"
            }}
            className="absolute top-0 bottom-0 w-1/2 bg-gradient-to-r from-transparent via-white/20 to-transparent skew-x-[-20deg] pointer-events-none"
          />
        </motion.div>
      </AnimatePresence>
      
      {/* High-tech tech lines */}
      {isAnimating && (
        <div className="absolute -inset-2 pointer-events-none">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.5, 0] }}
            transition={{ duration: 1, repeat: Infinity }}
            className="absolute top-1/2 -left-4 w-6 h-0.5 bg-cyan-400 rounded-full blur-[1px]" 
          />
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.5, 0] }}
            transition={{ duration: 1, repeat: Infinity, delay: 0.2 }}
            className="absolute top-1/3 -left-2 w-4 h-0.5 bg-cyan-400 rounded-full blur-[1px]" 
          />
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.5, 0] }}
            transition={{ duration: 1, repeat: Infinity, delay: 0.4 }}
            className="absolute top-2/3 -left-2 w-4 h-0.5 bg-cyan-400 rounded-full blur-[1px]" 
          />
        </div>
      )}
    </div>
  );
}