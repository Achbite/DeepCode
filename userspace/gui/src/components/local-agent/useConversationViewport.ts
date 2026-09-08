import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionProjection } from '@deepcode/protocol';

interface SessionViewport {
  mode: 'following' | 'detached';
  scrollTop: number;
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
        scrollTop: bodyRef.current?.scrollTop ?? lastScrollTopRef.current,
      });
    }
  }, [applyLatestFollowMode]);

  const scrollToLatestNow = useCallback((behavior: ScrollBehavior = 'auto') => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior });
  }, []);

  const scheduleScrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!followingLatestRef.current || pendingViewportRestoreRef.current !== null) return;
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (followingLatestRef.current && pendingViewportRestoreRef.current === null) {
        scrollToLatestNow(behavior);
      }
    });
  }, [scrollToLatestNow]);

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
      body.scrollTop = following ? body.scrollHeight : (saved?.scrollTop ?? 0);
      lastScrollTopRef.current = body.scrollTop;
      pendingViewportRestoreRef.current = null;
    });
  }, [
    applyLatestFollowMode,
    loading,
    presentationLayoutKey,
    projection?.sessionId,
    sessionId,
    timelineExtentKey,
  ]);

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
      if (detachedViewportFrameRef.current !== null) {
        window.cancelAnimationFrame(detachedViewportFrameRef.current);
      }
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
        currentBody.scrollTop = currentSaved.scrollTop;
        lastScrollTopRef.current = currentBody.scrollTop;
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
  }, [scheduleScrollToLatest, sessionId]);

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
    setLatestFollowMode(true);
    scheduleScrollToLatest('smooth');
  };

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
          scrollTop: body.scrollTop,
        });
      }
    },
  };

  return { bodyRef, transcriptRef, messageEndRef, bodyHandlers, followingLatest, setLatestFollowMode, scrollToLatest };
}

export type ConversationViewport = ReturnType<typeof useConversationViewport>;
