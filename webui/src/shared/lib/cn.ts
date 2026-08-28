import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: readonly ClassValue[]) {
  return twMerge(clsx(inputs))
}
