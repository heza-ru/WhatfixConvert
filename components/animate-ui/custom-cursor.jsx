'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';

export function CustomCursor() {
  const [visible, setVisible]   = useState(false);
  const [variant, setVariant]   = useState('default'); // default | hover | click
  const rawX  = useMotionValue(-100);
  const rawY  = useMotionValue(-100);
  const springCfg = { stiffness: 500, damping: 35, mass: 0.5 };
  const x = useSpring(rawX, springCfg);
  const y = useSpring(rawY, springCfg);

  // Outer dot — slower spring for trail effect
  const trailX = useSpring(rawX, { stiffness: 120, damping: 20, mass: 0.8 });
  const trailY = useSpring(rawY, { stiffness: 120, damping: 20, mass: 0.8 });

  useEffect(() => {
    const onMove = (e) => {
      rawX.set(e.clientX);
      rawY.set(e.clientY);
      setVisible(true);
    };
    const onLeave  = () => setVisible(false);
    const onEnter  = () => setVisible(true);
    const onDown   = () => setVariant('click');
    const onUp     = () => setVariant('default');

    const onHoverIn  = () => setVariant('hover');
    const onHoverOut = () => setVariant('default');

    const addHoverListeners = () => {
      document.querySelectorAll('button, a, [role="button"], input, textarea, select, label').forEach(el => {
        el.addEventListener('mouseenter', onHoverIn);
        el.addEventListener('mouseleave', onHoverOut);
      });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    window.addEventListener('mouseenter', onEnter);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    addHoverListeners();

    const observer = new MutationObserver(addHoverListeners);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('mouseenter', onEnter);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      observer.disconnect();
    };
  }, [rawX, rawY]);

  const dotSize      = variant === 'hover' ? 40 : variant === 'click' ? 14 : 10;
  const dotOpacity   = variant === 'hover' ? 0.15 : 0.8;
  const trailSize    = variant === 'hover' ? 60 : 36;
  const trailOpacity = variant === 'hover' ? 0.08 : 0.25;

  return (
    <>
      {/* Inner sharp dot */}
      <motion.div
        className="fixed top-0 left-0 pointer-events-none z-[9999] rounded-full mix-blend-difference"
        style={{
          x, y,
          width: dotSize, height: dotSize,
          translateX: '-50%', translateY: '-50%',
          backgroundColor: '#FF6B18',
          opacity: visible ? dotOpacity : 0,
        }}
        animate={{ width: dotSize, height: dotSize, opacity: visible ? dotOpacity : 0 }}
        transition={{ duration: 0.15 }}
      />
      {/* Trailing ring */}
      <motion.div
        className="fixed top-0 left-0 pointer-events-none z-[9998] rounded-full border border-[#FF6B18]"
        style={{
          x: trailX, y: trailY,
          width: trailSize, height: trailSize,
          translateX: '-50%', translateY: '-50%',
          opacity: visible ? trailOpacity : 0,
        }}
        animate={{ width: trailSize, height: trailSize, opacity: visible ? trailOpacity : 0 }}
        transition={{ duration: 0.2 }}
      />
    </>
  );
}
