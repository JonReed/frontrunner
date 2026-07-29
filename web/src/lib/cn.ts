import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class joiner with Tailwind conflict resolution — shared with the inherited docs UI. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
