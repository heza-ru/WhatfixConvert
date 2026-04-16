'use client';

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export function BeamBorder({ children, className = '', active = false, color = '#FF6B18' }) {
  return (
    <div className={cn('relative', className)}>
      {/* Animated gradient border */}
      <div
        className="absolute -inset-[1px] rounded-[inherit] overflow-hidden pointer-events-none"
        style={{ opacity: active ? 1 : 0, transition: 'opacity 0.3s' }}
      >
        <motion.div
          className="absolute inset-0 rounded-[inherit]"
          style={{
            background: `conic-gradient(from 0deg, transparent 30%, ${color} 50%, transparent 70%)`,
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
        />
        <div className="absolute inset-[1px] rounded-[inherit] bg-surface-1" />
      </div>
      {children}
    </div>
  );
}

export function GlowBorder({ children, className = '', color = '#FF6B18' }) {
  return (
    <div className={cn('relative group', className)}>
      <div
        className="absolute -inset-[1px] rounded-[inherit] opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-sm pointer-events-none"
        style={{ background: `linear-gradient(135deg, ${color}40, transparent, ${color}40)` }}
      />
      <div className="absolute -inset-[1px] rounded-[inherit] opacity-0 group-hover:opacity-60 transition-opacity duration-500 pointer-events-none"
        style={{ background: `linear-gradient(135deg, ${color}20, transparent, ${color}20)` }}
      />
      {children}
    </div>
  );
}
