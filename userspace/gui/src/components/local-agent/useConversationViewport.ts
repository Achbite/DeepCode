import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionProjection } from '@deepcode/protocol';

interface SessionViewport {
  mode: 'following' | 'detached';
  scrollTop: number;
  anchor?: { key: string; offset: number };
}

interface ConversationViewportInput {
  sessionId: string | null;
  loading: boolean;
  projection: SessionProjection | null;
  presentationLayoutKey: string;
  assistantDraftLayoutKey: string;
  timelineExtentKey: string;
}

export function useConversationViewport({
  sessionId,
  loading,
  projection,
  presentationLayoutKey,
  assistantDraftLayoutKey,
  timelineExtentKey,
}: ConversationViewportInput) {
  const [followingLatest, setFollowingLatest] = useState(true);
  const [latestRequest, setLatestRequest] = useState(0);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const activeViewRef = useRef<string | null>(sessionId);
  const sessionViewportsRef = useRef(new Map<string, SessionViewport>());
  const pendingViewportRestoreRef = useRef<string | null>(null);
  const followingLatestRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  const touchScrollActiveRef = useRef(false);
  const pointerScrollActiveRef = useRef(false);
  const transientUserScrollRef = useRef(false);
  const transientUserScrollFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const viewportRestoreFrameRef = useRef<number | null>(null);
  const detachedViewportFrameRef = useRef<number | null>(null);
  const capturePosition = useCallback((): Pick<SessionViewport, 'scrollTop' | 'anchor'> => {
    const body = bodyRef.current;
    if (!body) return { scrollTop: lastScrollTopRef.current };
    const top = body.getBoundingClientRect().top;
    const node = [...body.querySelectorAll<HTMLElement>('[data-conversation-anchor]')]
      .find((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().bottom > top);
    return { scrollTop: body.scrollTop, ...(node ? { anchor: { key: node.dataset.conversationAnchor!, offset: node.getBoundingClientRect().top - top } } : {}) };
  }, []);
  const restorePosition = useCallback((saved: SessionViewport) => {
    const body = bodyRef.current;
    if (!body) return;
    const anchor = saved.anchor;
    const node = anchor ? [...body.querySelectorAll<HTMLElement>('[data-conversation-anchor]')]
      .find((node) => node.dataset.conversationAnchor === anchor.key && node.getClientRects().length > 0) : undefined;
    body.scrollTop = node && anchor
      ? body.scrollTop + node.getBoundingClientRect().top - body.getBoundingClientRect().top - anchor.offset
      : saved.scrollTop;
    lastScrollTopRef.current = body.scrollTop;
  }, []);
  const applyLatestFollowMode = useCallback((following: boolean) => {
    followingLatestRef.current = following;
    setFollowingLatest(following);
  }, []);

  const setLatestFollowMode = useCallback((following: boolean) => {
    applyLatestFollowMode(following);
    const activeSessionId = activeViewRef.current;
    if (activeSessionId && pendingViewportRestoreRef.current !== activeSessionId) {
      sessionViewportsRef.current.set(activeSessionId, {
        mode: following ? 'following' : 'detached',
        ...capturePosition(),
      });
    }
  }, [applyLatestFollowMode, capturePosition]);

  const scrollToLatestNow = useCallback((behavior: ScrollBehavior = 'auto') => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior });
  }, []);

  const scheduleScrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!followingLatestRef.current || pendingViewportRestoreRef.current !== null) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (followingLatestRef.current && pendingViewportRestoreRef.current === null) {
        scrollToLatestNow(behavior);
      }
    });
  }, [scrollToLatestNow]);

  // Virtual rows and asynchronous media use the same anchor owner as user
  // scrolling. Apply layout corrections even during a continuous wheel gesture.
  const preserveReadingPosition = useCallback(() => {
    if (pendingViewportRestoreRef.current !== null) return;
    if (followingLatestRef.current) { scheduleScrollToLatest(); return; }
    const saved = activeViewRef.current ? sessionViewportsRef.current.get(activeViewRef.current) : undefined;
    if (saved?.mode === 'detached') restorePosition(saved);
  }, [restorePosition, scheduleScrollToLatest]);

  const markTransientUserScroll = useCallback(() => {
    transientUserScrollRef.current = true;
    if (transientUserScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(transientUserScrollFrameRef.current);
    }
    transientUserScrollFrameRef.current = window.requestAnimationFrame(() => {
      transientUserScrollFrameRef.current = window.requestAnimationFrame(() => {
        transientUserScrollRef.current = false;
        transientUserScrollFrameRef.current = null;
      });
    });
  }, []);

  useLayoutEffect(() => {
    if (activeViewRef.current !== sessionId) {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      pendingViewportRestoreRef.current = sessionId;
      activeViewRef.current = sessionId;
      const saved = sessionId ? sessionViewportsRef.current.get(sessionId) : undefined;
      applyLatestFollowMode(saved?.mode !== 'detached');
    }
  }, [applyLatestFollowMode, sessionId]);

  useLayoutEffect(() => {
    if (!sessionId || !loading || projection !== null) return;
    if (pendingViewportRestoreRef.current === sessionId) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    pendingViewportRestoreRef.current = sessionId;
  }, [loading, projection, sessionId]);

  useLayoutEffect(() => {
    if (
      !sessionId
      || pendingViewportRestoreRef.current !== sessionId
      || loading
      || projection?.sessionId !== sessionId
    ) return;
    if (viewportRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportRestoreFrameRef.current);
    }
    const targetSessionId = sessionId;
    viewportRestoreFrameRef.current = window.requestAnimationFrame(() => {
      viewportRestoreFrameRef.current = null;
      if (
        activeViewRef.current !== targetSessionId
        || pendingViewportRestoreRef.current !== targetSessionId
      ) return;
      const body = bodyRef.current;
      if (!body) return;
      const saved = sessionViewportsRef.current.get(targetSessionId);
      const following = saved?.mode !== 'detached';
      applyLatestFollowMode(following);
      if (following) body.scrollTop = body.scrollHeight;
      else restorePosition(saved!);
      lastScrollTopRef.current = body.scrollTop;
      pendingViewportRestoreRef.current = null;
    });
  }, [
    applyLatestFollowMode,
    loading,
    presentationLayoutKey,
    restorePosition,
    projection?.sessionId,
    sessionId,
    timelineExtentKey,
  ]);

  // React layout changes (including process disclosure at completion) must preserve
  // the reader's anchor before paint, even during a wheel gesture. ResizeObserver
  // continues to cover asynchronous image/code layout outside React commits.
  useLayoutEffect(() => {
    if (followingLatestRef.current || pendingViewportRestoreRef.current !== null) return;
    const saved = sessionId ? sessionViewportsRef.current.get(sessionId) : undefined;
    if (saved?.mode === 'detached') restorePosition(saved);
  });

  useEffect(() => {
    if (followingLatest) scheduleScrollToLatest();
  }, [
    assistantDraftLayoutKey,
    followingLatest,
    scheduleScrollToLatest,
    timelineExtentKey,
  ]);

  useEffect(() => {
    const body = bodyRef.current;
    const transcript = transcriptRef.current;
    if (typeof ResizeObserver === 'undefined' || !body || !transcript) return undefined;
    const observer = new ResizeObserver(() => {
      if (pendingViewportRestoreRef.current !== null) return;
      if (followingLatestRef.current) {
        scheduleScrollToLatest();
        return;
      }
      const activeSessionId = activeViewRef.current;
      const saved = activeSessionId
        ? sessionViewportsRef.current.get(activeSessionId)
        : undefined;
      const userScrolling = transientUserScrollRef.current
        || touchScrollActiveRef.current
        || pointerScrollActiveRef.current;
      if (!activeSessionId || saved?.mode !== 'detached' || userScrolling) return;
      if (detachedViewportFrameRef.current !== null) return;
      detachedViewportFrameRef.current = window.requestAnimationFrame(() => {
        detachedViewportFrameRef.current = null;
        const currentBody = bodyRef.current;
        const currentSaved = sessionViewportsRef.current.get(activeSessionId);
        if (
          !currentBody
          || activeViewRef.current !== activeSessionId
          || followingLatestRef.current
          || pendingViewportRestoreRef.current !== null
          || currentSaved?.mode !== 'detached'
          || transientUserScrollRef.current
          || touchScrollActiveRef.current
          || pointerScrollActiveRef.current
        ) return;
        restorePosition(currentSaved);
      });
    });
    observer.observe(transcript);
    observer.observe(body);
    return () => {
      observer.disconnect();
      if (detachedViewportFrameRef.current !== null) {
        window.cancelAnimationFrame(detachedViewportFrameRef.current);
        detachedViewportFrameRef.current = null;
      }
    };
  }, [restorePosition, scheduleScrollToLatest, sessionId]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    if (viewportRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportRestoreFrameRef.current);
    }
    if (detachedViewportFrameRef.current !== null) {
      window.cancelAnimationFrame(detachedViewportFrameRef.current);
    }
    if (transientUserScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(transientUserScrollFrameRef.current);
    }
  }, []);

  useEffect(() => {
    const finishPointerScroll = () => {
      if (!pointerScrollActiveRef.current) return;
      pointerScrollActiveRef.current = false;
      markTransientUserScroll();
    };
    window.addEventListener('pointerup', finishPointerScroll);
    window.addEventListener('pointercancel', finishPointerScroll);
    return () => {
      window.removeEventListener('pointerup', finishPointerScroll);
      window.removeEventListener('pointercancel', finishPointerScroll);
    };
  }, [markTransientUserScroll]);

  const scrollToLatest = () => {
    setLatestRequest((value) => value + 1);
    setLatestFollowMode(true);
    scheduleScrollToLatest('smooth');
  };

  const scrollToAnchor = useCallback((key: string) => {
    const body = bodyRef.current;
    const node = body && [...body.querySelectorAll<HTMLElement>('[data-conversation-anchor]')]
      .find((item) => item.dataset.conversationAnchor === key);
    if (!body || !node) return;
    applyLatestFollowMode(false);
    const target = node.getClientRects().length ? node : node.closest('.conversation-round')!;
    body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
    lastScrollTopRef.current = body.scrollTop;
    if (activeViewRef.current) sessionViewportsRef.current.set(activeViewRef.current, {
      mode: 'detached', ...capturePosition(),
    });
  }, [applyLatestFollowMode, capturePosition]);

  const bodyHandlers: React.HTMLAttributes<HTMLDivElement> = {
    onWheel: (event) => {
      if (pendingViewportRestoreRef.current === sessionId) return;
      markTransientUserScroll();
      if (event.deltaY < 0) setLatestFollowMode(false);
    },
    onPointerDown: (event) => {
      if (event.target === event.currentTarget) pointerScrollActiveRef.current = true;
    },
    onKeyDown: (event) => {
      const scrollsAway = ['ArrowUp', 'PageUp', 'Home'].includes(event.key);
      const scrollsTowardLatest = ['ArrowDown', 'PageDown', 'End'].includes(event.key);
      if (!scrollsAway && !scrollsTowardLatest) return;
      markTransientUserScroll();
      if (scrollsAway) setLatestFollowMode(false);
    },
    onTouchStart: (event) => {
      touchScrollActiveRef.current = true;
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
    },
    onTouchMove: (event) => {
      const currentY = event.touches[0]?.clientY;
      const previousY = lastTouchYRef.current;
      if (currentY !== undefined) {
        if (previousY !== null && currentY > previousY + 2) setLatestFollowMode(false);
        lastTouchYRef.current = currentY;
      }
    },
    onTouchEnd: () => {
      touchScrollActiveRef.current = false;
      lastTouchYRef.current = null;
      markTransientUserScroll();
    },
    onTouchCancel: () => {
      touchScrollActiveRef.current = false;
      lastTouchYRef.current = null;
    },
    onScroll: (event) => {
      const body = event.currentTarget;
      if (
        pendingViewportRestoreRef.current === sessionId
        || (loading && projection === null)
      ) return;
      const scrolledUp = body.scrollTop < lastScrollTopRef.current - 2;
      lastScrollTopRef.current = body.scrollTop;
      const userDriven = transientUserScrollRef.current
        || touchScrollActiveRef.current
        || pointerScrollActiveRef.current;
      if (!userDriven) return;
      const distanceFromLatest = body.scrollHeight - body.scrollTop - body.clientHeight;
      if (scrolledUp && followingLatestRef.current) setLatestFollowMode(false);
      if (!followingLatestRef.current && distanceFromLatest <= 2) {
        setLatestFollowMode(true);
        return;
      }
      if (sessionId) {
        sessionViewportsRef.current.set(sessionId, {
          mode: followingLatestRef.current ? 'following' : 'detached',
          ...capturePosition(),
        });
      }
    },
  };

  return { bodyRef, transcriptRef, messageEndRef, bodyHandlers, followingLatest, setLatestFollowMode, scrollToLatest, scrollToAnchor, latestRequest, preserveReadingPosition };
}

export type ConversationViewport = ReturnType<typeof useConversationViewport>;
