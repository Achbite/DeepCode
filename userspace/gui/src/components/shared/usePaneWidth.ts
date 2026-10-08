import { useLayoutEffect, useState, type RefObject } from 'react';
import { restoredInterfaceView, useInterfaceReloadView } from '../../services/interfaceReload';
import { boundedPaneWidth } from './paneGeometry';

/** UI view state only; the containing panel keeps enough room for its content. */
export function usePaneWidth(key: string, geometry: { initial: number; min: number; max: number; reserve: number }, container: RefObject<HTMLElement | null>) {
  const [requested, setWidth] = useState(() => restoredInterfaceView(key, geometry.initial));
  const [available, setAvailable] = useState(geometry.max);
  useInterfaceReloadView(key, requested);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setAvailable(Math.max(geometry.min, element.getBoundingClientRect().width - geometry.reserve));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, geometry]);
  const max = Math.min(geometry.max, available);
  return { width: boundedPaneWidth(requested, geometry.min, max), min: geometry.min, max, setWidth };
}
