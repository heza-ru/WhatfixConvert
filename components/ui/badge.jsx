import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:     'border-transparent bg-[#FFE9DC] text-[#c0370a]',
        secondary:   'border-[#e5e7eb] bg-[#f3f4f6] text-[#6b7280]',
        destructive: 'border-transparent bg-[#fee2e2] text-[#dc2626]',
        outline:     'border-[#e5e7eb] text-[#374151] bg-white',
        success:     'border-transparent bg-[#d1fae5] text-[#059669]',
        warning:     'border-transparent bg-[#fef3c7] text-[#d97706]',
        converting:  'border-transparent bg-[#dbeafe] text-[#2563eb]',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
