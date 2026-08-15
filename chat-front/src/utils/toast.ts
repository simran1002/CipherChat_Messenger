/**
 * Typed accessor for the global toast host installed by components/Toaster.
 * Replaces the legacy src/Toaster.js shim.
 */
export type ToastType = "success" | "error" | "info" | "warning";

export function makeToast(type: ToastType, message: string): void {
  window.makeToast?.(type, message);
}
