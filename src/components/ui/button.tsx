import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border text-sm font-medium transition duration-200 ease-out disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]',
  {
    variants: {
      variant: {
        primary:
          'border-[rgba(245,180,76,0.55)] bg-[linear-gradient(135deg,rgba(245,180,76,0.28),rgba(245,180,76,0.12))] text-[var(--text-strong)] shadow-[0_12px_30px_rgba(15,11,7,0.28)] hover:border-[rgba(255,210,129,0.8)] hover:bg-[linear-gradient(135deg,rgba(255,199,107,0.35),rgba(245,180,76,0.16))]',
        ghost:
          'border-[rgba(242,191,110,0.16)] bg-[rgba(16,15,11,0.5)] text-[var(--text-strong)] hover:border-[rgba(242,191,110,0.32)] hover:bg-[rgba(33,29,22,0.78)]',
        subtle:
          'border-[rgba(143,123,84,0.18)] bg-[rgba(20,18,13,0.72)] text-[var(--muted-strong)] hover:border-[rgba(242,191,110,0.26)] hover:text-[var(--text-strong)]',
      },
      size: {
        default: 'h-11 px-4',
        sm: 'h-9 px-3 text-xs',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: {
      variant: 'ghost',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, size, variant, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      />
    )
  },
)

Button.displayName = 'Button'