(input) => {
  const selected = input.selector ? document.querySelector(input.selector) : null;
  if (input.selector && !selected) throw Error('Element not found: ' + input.selector);
  if (input.operation === 'scroll') {
    const target = selected ?? document.scrollingElement;
    if (!target) throw Error('Page has no scrolling element');
    target.scrollBy({ left: input.x ?? 0, top: input.y ?? 0, behavior: 'instant' });
    return { x: target.scrollLeft, y: target.scrollTop };
  }
  if (input.operation === 'type') {
    if (!(selected instanceof HTMLInputElement || selected instanceof HTMLTextAreaElement)) throw Error('Element is not a text input');
    if (selected.disabled || selected.readOnly) throw Error('Text input is not editable');
    selected.focus();
    const prototype = selected instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(selected, input.text);
    selected.dispatchEvent(new Event('input', { bubbles: true }));
    selected.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: true };
  }
  if (input.operation !== 'click') throw Error('Unsupported browser operation');
  if (selected) selected.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  const rect = selected?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : input.x;
  const y = rect ? rect.top + rect.height / 2 : input.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw Error('Click is outside the viewport');
  const target = document.elementFromPoint(x, y);
  if (!target || (selected && target !== selected && !selected.contains(target))) throw Error('Click target is covered');
  if (target.closest(':disabled,[aria-disabled="true"]')) throw Error('Click target is disabled');
  const options = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
  const pointer = { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const pointerAccepted = target.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
  if (pointerAccepted) {
    const mouseAccepted = target.dispatchEvent(new MouseEvent('mousedown', { ...options, buttons: 1 }));
    if (mouseAccepted) target.closest('button,input,textarea,select,a[href],[tabindex],[contenteditable="true"]')?.focus();
  }
  target.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
  if (pointerAccepted) target.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }));
  target.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0, detail: 1 }));
  return { clicked: true, x, y };
}
