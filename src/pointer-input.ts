/** Keep mobile drawer gestures outside floating controls, while Pencil taps still activate buttons. */
export function isolateFloatingInput(element: HTMLElement): () => void {
  let tap: { id: number; button: HTMLButtonElement; x: number; y: number } | null = null;
  let clicked: HTMLButtonElement | null = null;
  const buttonAt = (target: EventTarget | null) => {
    const button = (target as Element | null)?.closest<HTMLButtonElement>('button');
    return button && element.contains(button) && !button.disabled ? button : null;
  };
  const down = (event: PointerEvent) => {
    clicked = null;
    const button = buttonAt(event.target);
    tap = event.pointerType === 'pen' && event.button === 0 && button
      ? { id: event.pointerId, button, x: event.clientX, y: event.clientY } : null;
  };
  const move = (event: PointerEvent) => {
    if (tap?.id === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) >= 7) { clicked = tap.button; tap = null; }
  };
  const up = (event: PointerEvent) => {
    const current = tap;
    if (current?.id !== event.pointerId) return;
    tap = null;
    clicked = current.button;
    if (buttonAt(event.target) !== current.button || Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 7) return;
    // iPadOS may omit the compatibility click when native touch events are isolated.
    // Activate on release, then consume its optional trusted click exactly once.
    current.button.click();
  };
  const cancel = (event: PointerEvent) => { if (tap?.id === event.pointerId) { clicked = tap.button; tap = null; } };
  const click = (event: MouseEvent) => {
    if (event.isTrusted && event.detail > 0 && clicked && buttonAt(event.target) === clicked) {
      clicked = null; event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const touch = (event: TouchEvent) => {
    event.stopPropagation();
    if (event.type === 'touchmove' && event.cancelable && !buttonAt(event.target)) event.preventDefault();
  };
  const touchEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('lostpointercapture', cancel);
  element.addEventListener('click', click, true);
  for (const type of touchEvents) element.addEventListener(type, touch, { passive: false });
  return () => {
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', up);
    element.removeEventListener('pointercancel', cancel);
    element.removeEventListener('lostpointercapture', cancel);
    element.removeEventListener('click', click, true);
    for (const type of touchEvents) element.removeEventListener(type, touch);
  };
}
