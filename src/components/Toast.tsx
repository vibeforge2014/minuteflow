import { CheckCircle, X } from "@phosphor-icons/react";
import { useEffect } from "react";

export function Toast({ message, onClose }: { message: string; onClose(): void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 5_000);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);
  return (
    <div className="toast" role="status">
      <CheckCircle size={19} weight="fill" />
      <span>{message}</span>
      <button onClick={onClose}><X size={15} /></button>
    </div>
  );
}

