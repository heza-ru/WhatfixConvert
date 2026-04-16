'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

export function AnimTooltip({
  children,
  content,
  side = 'top',
  sideOffset = 6,
  className,
  delayDuration = 400,
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <div className="inline-flex items-center">{children}</div>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={sideOffset}
            className={cn(
              'z-50 max-w-[220px] rounded-lg border border-[#e5e7eb] bg-white px-3 py-2',
              'text-xs text-[#374151] shadow-elevated leading-relaxed',
              'animate-tooltip-in',
              className
            )}
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-[#e5e7eb]" width={10} height={5} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
