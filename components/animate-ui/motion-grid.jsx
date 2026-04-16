'use client';

import { useEffect, useRef } from 'react';

export function MotionGrid({ className = '' }) {
  const canvasRef = useRef(null);
  const mouseRef  = useRef({ x: -999, y: -999 });
  const rafRef    = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const CELL = 60;
    let W, H, cols, rows;

    const resize = () => {
      W = canvas.width  = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
      cols = Math.ceil(W / CELL) + 1;
      rows = Math.ceil(H / CELL) + 1;
    };
    resize();

    const onMouse = (e) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onLeave = () => { mouseRef.current = { x: -999, y: -999 }; };

    canvas.addEventListener('mousemove', onMouse);
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', resize);

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const px = c * CELL;
          const py = r * CELL;
          const dx = mx - px;
          const dy = my - py;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const maxR  = 200;
          const infl  = Math.max(0, 1 - dist / maxR);

          const baseAlpha  = 0.06;
          const hovrAlpha  = baseAlpha + infl * 0.18;
          const dotSize    = 1.2 + infl * 2.5;

          // Grid lines
          ctx.beginPath();
          ctx.moveTo(px, 0); ctx.lineTo(px, H);
          ctx.moveTo(0, py); ctx.lineTo(W, py);
          ctx.strokeStyle = `rgba(255,107,24,${baseAlpha + infl * 0.06})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();

          // Intersection glow dots
          ctx.beginPath();
          ctx.arc(px, py, dotSize, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,107,24,${hovrAlpha})`;
          ctx.fill();
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(rafRef.current);
      canvas.removeEventListener('mousemove', onMouse);
      canvas.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full pointer-events-none ${className}`}
      style={{ mixBlendMode: 'normal' }}
    />
  );
}
