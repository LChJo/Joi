import type { KeyboardEvent } from "react";

export function submitComposerOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit?: () => void): void {
  if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey) return;
  // Some IMEs report the confirmation key as 229 without setting isComposing.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

  event.preventDefault();
  if (event.repeat) return;
  if (submit === undefined) event.currentTarget.form?.requestSubmit();
  else submit();
}
