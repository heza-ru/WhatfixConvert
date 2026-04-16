import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 select-none',
  {
    variants: {
      variant: {
        default:     'bg-[#FF6B18] text-white hover:bg-[#e05a0d] shadow-glow-sm hover:shadow-glow-orange',
        destructive: 'bg-[#ef4444] text-white hover:bg-[#dc2626]',
        outline:     'border border-[#e5e7eb] bg-white text-[#374151] hover:bg-[#f9fafb]',
        secondary:   'bg-[#f3f4f6] text-[#374151] hover:bg-[#e5e7eb]',
        ghost:       'text-[#374151] hover:bg-[#f3f4f6] hover:text-[#111827]',
        link:        'text-primary underline-offset-4 hover:underline',
        glass:       'bg-white border border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb] shadow-card',
        glow:        'bg-[#FF6B18] text-white hover:bg-[#e05a0d] shadow-glow-sm hover:shadow-glow-orange active:scale-[0.98]',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm:      'h-8 rounded-md px-3 text-xs',
        lg:      'h-12 rounded-lg px-8 text-base',
        xl:      'h-14 rounded-xl px-10 text-lg font-semibold',
        icon:    'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = 'Button';

export { Button, buttonVariants };
