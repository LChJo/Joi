import { useI18n } from "./i18n";
import { cloneElement, useCallback, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

interface Anchor { x: number; y: number; above: boolean }
interface Position { left: number; top: number }

const EDGE = 8;
const FLIP_MARGIN = 130;

/**
 * Lightweight hover/focus tooltip rendered in a portal so it is never clipped by
 * scrollable ancestors (charts, tables). Wraps a single element via cloneElement,
 * so it adds no DOM wrapper and keeps grid/table layouts intact. The popup is a
 * visual duplicate of the trigger's accessible name, hence aria-hidden.
 */
export function Tooltip({ children, content }: { children: ReactElement; content: ReactNode }) {
  useI18n();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [position, setPosition] = useState<Position | null>(null);

  const show = useCallback((event: SyntheticEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const above = rect.bottom > window.innerHeight - FLIP_MARGIN && rect.top > FLIP_MARGIN;
    setAnchor({ above, x: rect.left + rect.width / 2, y: above ? rect.top : rect.bottom });
  }, []);
  const hide = useCallback(() => { setAnchor(null); setPosition(null); }, []);

  useLayoutEffect(() => {
    if (anchor === null) return;
    const element = popupRef.current;
    if (element === null) return;
    const width = element.offsetWidth; const height = element.offsetHeight;
    const left = Math.max(EDGE, Math.min(anchor.x - width / 2, window.innerWidth - width - EDGE));
    const top = anchor.above ? Math.max(EDGE, anchor.y - height - EDGE) : anchor.y + EDGE;
    setPosition({ left, top });
  }, [anchor]);

  useLayoutEffect(() => {
    if (anchor === null) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => { window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); };
  }, [anchor, hide]);

  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, { onBlur: hide, onFocus: show, onMouseEnter: show, onMouseLeave: hide });
  return <>
    {trigger}
    {anchor === null ? null : createPortal(
      <div aria-hidden className="app-tooltip" ref={popupRef} style={{ left: position?.left ?? anchor.x, top: position?.top ?? anchor.y, visibility: position === null ? "hidden" : "visible" }}>{content}</div>,
      document.body,
    )}
  </>;
}
