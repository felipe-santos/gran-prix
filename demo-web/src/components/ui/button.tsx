import * as React from "react"
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

import { cn } from "../../lib/utils"

/*
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
} 
*/


const buttonVariants = (variant: 'default' | 'secondary' = 'default') => {
    switch (variant) {
        case 'secondary': return "bg-zinc-800 text-zinc-100 hover:bg-zinc-700";
        default: return "bg-green-600 text-white hover:bg-green-700";
    }
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary'
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-4 py-2",
          buttonVariants(variant),
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
