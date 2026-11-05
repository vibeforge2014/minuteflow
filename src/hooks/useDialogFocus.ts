import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

/**
 * 对话框的统一键盘行为：打开后把焦点移入、Tab 留在弹层内、关闭后还给触发控件。
 * 只有传入 onEscape 的普通弹层才允许 Esc 关闭；首次授权/配置墙不会被意外跳过。
 */
export function useDialogFocus<T extends HTMLElement>(
  open: boolean,
  options: { initialFocus?: string; onEscape?: () => void } = {}
) {
  const dialogRef = useRef<T | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const root = dialogRef.current;
      const target = options.initialFocus
        ? root?.querySelector<HTMLElement>(options.initialFocus)
        : root?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      target?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && options.onEscape) {
        event.preventDefault();
        options.onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => {
          if (element.tabIndex < 0 || element.matches(":disabled")
            || element.closest("[hidden], [inert], [aria-hidden='true']")
            || !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") return false;
          // Chromium may retain layout rects for controls inside closed details. Only
          // the direct summary remains reachable, including through nested disclosures.
          for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
            if (parent.tagName === "DETAILS" && !parent.hasAttribute("open")
              && !parent.querySelector(":scope > summary")?.contains(element)) return false;
          }
          return true;
        });
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [open, options.initialFocus, options.onEscape]);

  return dialogRef;
}
