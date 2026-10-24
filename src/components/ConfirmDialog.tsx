/**
 * 应用内确认对话框：替代原生 window.confirm，与设置/向导共用同一套
 * modal 样式、退场动画与焦点管理。用 useConfirmDialog() 驱动：
 *   const dialog = useConfirmDialog();
 *   if (!(await dialog.confirm({ title, body }))) return;
 *   <ConfirmDialog open={dialog.open} request={dialog.request} onSettle={dialog.settle} />
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useExitPresence } from "../hooks/useExitPresence";

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel?: string;
}

export function useConfirmDialog() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [open, setOpen] = useState(false);
  const resolveRef = useRef<((accepted: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmRequest) => new Promise<boolean>((resolve) => {
    // 上一次提问还未答复就被新提问覆盖：按取消结算，避免悬挂的 Promise。
    resolveRef.current?.(false);
    resolveRef.current = resolve;
    setRequest(next);
    setOpen(true);
  }), []);

  const settle = useCallback((accepted: boolean) => {
    if (!open) return;
    resolveRef.current?.(accepted);
    resolveRef.current = null;
    setOpen(false);
  }, [open]);

  // Escape 关闭等同取消；点击遮罩由 ConfirmDialog 内部转给 settle(false)。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") settle(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, settle]);

  return { confirm, open, request, settle };
}

export function ConfirmDialog({ open, request, onSettle }: {
  open: boolean;
  request: ConfirmRequest | null;
  onSettle(accepted: boolean): void;
}) {
  const { mounted, closing } = useExitPresence(open, 170);
  const dialogRef = useDialogFocus<HTMLElement>(open, {
    initialFocus: ".confirm-dialog__actions .button--primary"
  });
  if (!mounted || !request) return null;
  return (
    <div className={`modal-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onSettle(false)}>
      <section ref={dialogRef} className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <header className="confirm-dialog__header">
          <WarningCircle size={26} weight="duotone" />
          <div>
            <h2 id="confirm-dialog-title">{request.title}</h2>
            <p>{request.body}</p>
          </div>
        </header>
        <footer className="confirm-dialog__actions">
          <button className="button" onClick={() => onSettle(false)}>取消</button>
          <button className="button button--primary" onClick={() => onSettle(true)}>{request.confirmLabel ?? "确认"}</button>
        </footer>
      </section>
    </div>
  );
}
