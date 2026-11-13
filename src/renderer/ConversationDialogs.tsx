import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CONVERSATION_TITLE_MAX_LENGTH } from "../shared/conversations";
import { t } from "./i18n";

export function ConversationDialog({ title,children,onClose,alert = false,busy = false,initialFocus }: { title: string;children: ReactNode;onClose: () => void;alert?: boolean;busy?: boolean;initialFocus?: RefObject<HTMLInputElement | null> }) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  const pending = useRef(busy);
  useEffect(() => { close.current = onClose;pending.current = busy; },[onClose,busy]);
  useEffect(() => {
    const previous = document.activeElement;
    const root = ref.current;
    (initialFocus?.current ?? root?.querySelector<HTMLButtonElement>("button"))?.focus();
    initialFocus?.current?.select();
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
  },[initialFocus]);
  return createPortal(<div className="dialog-backdrop"><section aria-label={title} aria-modal="true" className="dialog chat-dialog" ref={ref} role={alert ? "alertdialog" : "dialog"} tabIndex={-1}><header><h2>{title}</h2>{alert ? null : <button aria-label={t("common.close")} className="button quiet" disabled={busy} onClick={onClose} type="button">×</button>}</header>{children}</section></div>,document.body);
}

export function DeleteConversationDialog({ title,busy,error,onCancel,onDelete }: { title: string;busy: boolean;error?: string | null;onCancel: () => void;onDelete: () => void }) {
  return <ConversationDialog alert busy={busy} onClose={onCancel} title={t("chat.deleteTitle")}><p>{t("chat.deleteHint",{ title })}</p>{error ? <p role="alert">{error}</p> : null}<footer><button className="button quiet" disabled={busy} onClick={onCancel} type="button">{t("common.cancel")}</button><button className="button danger" disabled={busy} onClick={onDelete} type="button">{t("common.delete")}</button></footer></ConversationDialog>;
}

export function RenameConversationDialog({ title,busy,error,onCancel,onSave }: { title: string;busy: boolean;error: string | null;onCancel: () => void;onSave: (title: string) => void }) {
  const [value,setValue] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const invalid = value.trim() === "" || value.trim().length > CONVERSATION_TITLE_MAX_LENGTH;
  return <ConversationDialog busy={busy} initialFocus={input} onClose={onCancel} title={t("chat.renameTitle")}>
    <form aria-busy={busy} className="chat-rename-form" onSubmit={event => { event.preventDefault();if (!busy && !invalid) onSave(value.trim()); }}>
      <label><span>{t("chat.titleLabel")}</span><input aria-invalid={invalid} disabled={busy} maxLength={CONVERSATION_TITLE_MAX_LENGTH} onChange={event => setValue(event.target.value)} ref={input} value={value} /></label>
      {error || invalid ? <p role="alert">{error ?? t("errors.conversationTitleInvalid")}</p> : null}
      <footer><button className="button quiet" disabled={busy} onClick={onCancel} type="button">{t("common.cancel")}</button><button className="button primary" disabled={busy || invalid} type="submit">{t("common.save")}</button></footer>
    </form>
  </ConversationDialog>;
}
