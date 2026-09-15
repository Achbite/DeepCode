import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './modalDialog.css';

/** The native top layer owns focus containment, nested dialogs and background inertness. */
export default function ModalDialog({ children, onClose, busy = false, className = '', ...label }: {
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const state = useRef({ onClose, busy });
  state.current = { onClose, busy };
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const dismiss = () => { if (!state.current.busy) state.current.onClose(); };
  return createPortal(<dialog ref={ref} {...label} className={`app-modal ${className}`} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); dismiss(); }}
    onKeyDown={(event) => { event.stopPropagation(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    {children}
  </dialog>, document.body);
}
