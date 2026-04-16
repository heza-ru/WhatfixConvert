'use client';

import { useRef, useCallback } from 'react';
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { cn } from '@/lib/utils';

export function SpringCard({ children, className = '', intensity = 12, glare = true }) {
  const ref  = useRef(null);
  const rotX = useMotionValue(0);
  const rotY = useMotionValue(0);
  const sx   = useSpring(rotX, { stiffness: 300, damping: 25 });
  const sy   = useSpring(rotY, { stiffness: 300, damping: 25 });

  const glareX = useMotionValue(50);
  const glareY = useMotionValue(50);

  const onMove = useCallback((e) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top)  / rect.height;
    rotX.set((py - 0.5) * -intensity);
    rotY.set((px - 0.5) *  intensity);
    glareX.set(px * 100);
    glareY.set(py * 100);
  }, [rotX, rotY, glareX, glareY, intensity]);

  const onLeave = useCallback(() => {
    rotX.set(0);
    rotY.set(0);
    glareX.set(50);
    glareY.set(50);
  }, [rotX, rotY, glareX, glareY]);

  const glareStyle = useTransform(
    [glareX, glareY],
    ([gx, gy]) => `radial-gradient(circle at ${gx}% ${gy}%, rgba(255,255,255,0.07) 0%, transparent 60%)`
  );

  return (
    <motion.div
      ref={ref}
      style={{ rotateX: sx, rotateY: sy, transformStyle: 'preserve-3d', perspective: 800 }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={cn('relative', className)}
    >
      {children}
      {glare && (
        <motion.div
          className="absolute inset-0 rounded-[inherit] pointer-events-none z-10"
          style={{ background: glareStyle }}
        />
      )}
    </motion.div>
  );
}
