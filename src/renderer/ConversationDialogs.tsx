import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";

export function ConversationDialog({ title,children,onClose,alert = false,busy = false }: { title: string;children: ReactNode;onClose: () => void;alert?: boolean;busy?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  const pending = useRef(busy);
  useEffect(() => { close.current = onClose;pending.current = busy; },[onClose,busy]);
  useEffect(() => {
    const previous = document.activeElement;
    const root = ref.current;
    root?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault();event.stopPropagation();if (!pending.current) close.current(); }
      if (event.key !== "Tab") return;
      const items = root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]');
      const first = items?.[0],last = items?.[items.length - 1];
      if (first === undefined) { event.preventDefault();root?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault();last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault();first.focus(); }
    };
    document.addEventListener("keydown",key);
    return () => { document.removeEventListener("keydown",key);if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  },[]);
  return createPortal(<div className="dialog-backdrop"><section aria-label={title} aria-modal="true" className="dialog chat-dialog" ref={ref} role={alert ? "alertdialog" : "dialog"} tabIndex={-1}><header><h2>{title}</h2>{alert ? null : <button aria-label={t("common.close")} className="button quiet" disabled={busy} onClick={onClose} type="button">×</button>}</header>{children}</section></div>,document.body);
}

export function DeleteConversationDialog({ title,busy,error,onCancel,onDelete }: { title: string;busy: boolean;error?: string | null;onCancel: () => void;onDelete: () => void }) {
  return <ConversationDialog alert busy={busy} onClose={onCancel} title={t("chat.deleteTitle")}><p>{t("chat.deleteHint",{ title })}</p>{error ? <p role="alert">{error}</p> : null}<footer><button className="button quiet" disabled={busy} onClick={onCancel} type="button">{t("common.cancel")}</button><button className="button danger" disabled={busy} onClick={onDelete} type="button">{t("common.delete")}</button></footer></ConversationDialog>;
}
