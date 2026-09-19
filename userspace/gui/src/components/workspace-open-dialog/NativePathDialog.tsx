import ModalDialog from '../shared/ModalDialog';
import { useEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { pickNativePath, type NativePathOptions, type NativePathSelection } from '../../services/runtimeAdapter';
import './workspaceOpenDialog.css';

interface NativePathDialogProps extends NativePathOptions {
  language: UiLanguage;
  onSelect: (path: string, kind: 'file' | 'directory') => void;
  onCancel: () => void;
}

/** One OS dialog per mounted selection, including React Strict Mode effects. */
export default function NativePathDialog(props: NativePathDialogProps) {
  const request = useRef<Promise<NativePathSelection | null> | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    request.current ??= pickNativePath(props);
    void request.current.then((selection) => {
      if (!active) return;
      if (selection === null) callbacks.current.onCancel();
      else callbacks.current.onSelect(selection.path, selection.kind);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
    // Selection options belong to this mounted dialog; callbacks may change as messages arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!error) return null;
  return <ModalDialog className="ws-open-dialog__backdrop" onClose={props.onCancel} aria-label={props.title}>
    <div className="ws-open-dialog ws-open-dialog--native"
      aria-label={props.title} onClick={(event) => event.stopPropagation()}>
      <div className="ws-open-dialog__header"><strong>{props.title}</strong></div>
      <p className="ws-open-dialog__error" role="alert">{error}</p>
      <div className="ws-open-dialog__footer">
        <button type="button" autoFocus className="ws-open-dialog__btn" onClick={props.onCancel}>
          {t(props.language, 'workspaceDialog.cancel')}
        </button>
      </div>
    </div>
  </ModalDialog>;
}
