import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArchiveIcon, DotsThreeIcon, FolderIcon, TrashIcon } from "@phosphor-icons/react";
import type { ConversationSummaryDto } from "../shared/conversations";
import { currentLocale, t } from "./i18n";

export function ConversationHistoryRow({ item,workbench,selected,disabled,onSelect,onArchive,onDelete }: { item: ConversationSummaryDto;workbench: string;selected: boolean;disabled: boolean;onSelect: () => void;onArchive: () => void;onDelete: () => void }) {
  const [tip,setTip] = useState<{ left: number;top: number } | null>(null);
  const [menu,setMenu] = useState<{ left: number;top: number } | null>(null);
  const row = useRef<HTMLDivElement>(null),trigger = useRef<HTMLButtonElement>(null),popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const position = (width: number,height: number) => {
    const box = row.current?.getBoundingClientRect();
    return { left: Math.max(8,Math.min(window.innerWidth - width - 8,box?.right ?? 8)),top: Math.max(8,Math.min(window.innerHeight - height - 8,box?.top ?? 8)) };
  };
  useEffect(() => {
    if (menu === null && tip === null) return;
    const dismiss = () => { setTip(null);setMenu(null); };
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !row.current?.contains(event.target) && !popup.current?.contains(event.target)) dismiss(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { dismiss();if (menu !== null) trigger.current?.focus(); } };
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",key);window.addEventListener("resize",dismiss);window.addEventListener("scroll",dismiss,true);
    return () => { document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",key);window.removeEventListener("resize",dismiss);window.removeEventListener("scroll",dismiss,true); };
  },[menu,tip]);
  useEffect(() => { if (menu !== null) popup.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); },[menu]);
  const showTip = () => { if (menu === null) setTip(position(320,160)); };
  return <div className="chat-history-row" ref={row}>
    <button aria-current={selected ? "page" : undefined} aria-describedby={tip === null ? undefined : id} className="chat-history-open" onBlur={() => setTip(null)} onClick={onSelect} onFocus={showTip} onMouseEnter={showTip} onMouseLeave={() => setTip(null)} type="button"><span>{item.title}</span></button>
    <button aria-expanded={menu !== null} aria-haspopup="menu" aria-label={t("chat.actions",{ title: item.title })} className="chat-history-actions" disabled={disabled} onClick={() => { setTip(null);setMenu(value => value === null ? position(180,100) : null); }} ref={trigger} type="button"><DotsThreeIcon /></button>
    {tip === null ? null : createPortal(<div className="chat-history-tooltip" id={id} role="tooltip" style={tip}><strong>{item.title}</strong><div><FolderIcon /><span>{workbench}</span><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString(currentLocale())}</time></div></div>,document.body)}
    {menu === null ? null : createPortal(<div aria-label={t("chat.actions",{ title: item.title })} className="chat-history-menu" ref={popup} role="menu" style={menu} onKeyDown={event => {
      if (event.key === "Tab") setMenu(null);
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (["ArrowDown","ArrowUp","Home","End"].includes(event.key)) { event.preventDefault();const index = buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
    }}><button disabled={item.canArchive === false} onClick={() => { setMenu(null);onArchive(); }} role="menuitem" type="button"><ArchiveIcon />{t("common.archive")}</button><button disabled={item.canArchive === false} onClick={() => { setMenu(null);onDelete(); }} role="menuitem" type="button"><TrashIcon />{t("common.delete")}</button>{item.canArchive === false ? <small>{t("chat.stopBeforeArchive")}</small> : null}</div>,document.body)}
  </div>;
}
