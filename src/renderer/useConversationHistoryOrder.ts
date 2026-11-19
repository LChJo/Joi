import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

const storageKey = "joi.conversationHistoryOrder";
type HistoryOrder = Record<string, string[]>;

function readOrder(): HistoryOrder {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, ids]) => Array.isArray(ids) && ids.every(id => typeof id === "string")));
  } catch {
    return {};
  }
}

export function applyHistoryOrder<T>(items: T[], ids: string[] | undefined, getId: (item: T) => string): T[] {
  if (ids === undefined) return items;
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (positions.get(getId(a)) ?? ids.length) - (positions.get(getId(b)) ?? ids.length));
}

export function useConversationHistoryOrder() {
  const [order, setOrder] = useState(readOrder);
  const [drag, setDrag] = useState<{ scope: string; source: string; target?: string } | null>(null);
  const focusAfterMove = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    focusAfterMove.current?.focus({ preventScroll: true });
    focusAfterMove.current = null;
  }, [order]);

  function move(scope: string, source: string, target: string, ids: string[]) {
    const ranked = new Set([...(order[scope] ?? []), ...ids]);
    const next = [...ranked];
    const destination = next.indexOf(target);
    next.splice(next.indexOf(source), 1);
    next.splice(destination, 0, source);
    const updated = { ...order, ...readOrder(), [scope]: next };
    try {
      localStorage.setItem(storageKey, JSON.stringify(updated));
    } catch { /* The current view can still be reordered when storage is unavailable. */ }
    setOrder(updated);
  }

  function sortable(scope: string, id: string, ids: string[], visibleIds: string[]) {
    if (visibleIds.length < 2) return undefined;
    const rank = visibleIds.indexOf(id);
    const active = drag?.scope === scope && drag.source !== id && visibleIds.includes(drag.source) ? drag : null;
    return {
      draggable: true,
      "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
      "data-dragging": drag?.scope === scope && drag.source === id ? "true" : undefined,
      "data-drop-position": active?.target === id ? (visibleIds.indexOf(active.source) < rank ? "after" : "before") : undefined,
      onDragStart(event: DragEvent<HTMLElement>) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-joi-history-order", "1");
        setDrag({ scope, source: id });
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (active === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (active.target !== id) setDrag({ ...active, target: id });
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDrag(current => current?.scope === scope && current.target === id ? { scope, source: current.source } : current);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (active === null) return;
        event.preventDefault();
        move(scope, active.source, id, ids);
        setDrag(null);
      },
      onDragEnd() { setDrag(null); },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        const neighbor = visibleIds[rank + (event.key === "ArrowUp" ? -1 : 1)];
        if (neighbor === undefined) return;
        focusAfterMove.current = event.currentTarget;
        move(scope, id, neighbor, ids);
      },
    } as const;
  }

  return { order, sortable };
}
