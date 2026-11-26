import { randomUUID } from "node:crypto";
import { canonicalJson } from "../governance/canonical.ts";

export interface ProjectionEvent {
  seq: number;
  streamInstanceId: string;
  event: "snapshot" | "delta" | "partial";
  cursor: string;
  occurredAt: number;
  revocationWatermark: string;
  payload: Record<string, unknown>;
}

export interface ProjectionSnapshotEnvelope<TSnapshot extends Record<string, unknown>> {
  snapshot: TSnapshot;
  cursor: string;
  streamInstanceId: string;
  seq: number;
}

export interface ProjectionSubscriber {
  id: string;
  tokenDigest: string;
  principalId: string;
  runtimeEpoch: string;
  conversationId: string;
  queue: Array<{ event: string; id?: string; data: string }>;
  closed: boolean;
  wake: (() => void) | null;
  close: (reason?: string) => void;
}

export interface ProjectionSourceAttach {
  detach: () => void;
}

export interface ProjectionHubOptions<TSnapshot extends Record<string, unknown>> {
  buildSnapshot: (params: {
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
  }) => Promise<TSnapshot | null>;
  /** W2-S2: Live source-read revocation watermark so historical frames & subscriptions invalidate immediately on revocation. */
  getRevocationWatermark?: (params: {
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
  }) => string;
  attachPiObserver?: (params: {
    runtimeEpoch: string;
    conversationId: string;
    onUpdate: (kind: "pi_view" | "pi_task_graph", detail?: Record<string, unknown>) => void;
    onEnd: (reason: string) => void;
  }) => Promise<ProjectionSourceAttach | null>;
  maxHistory?: number;
  maxClientQueue?: number;
  now?: () => number;
}

interface ConversationProjection<TSnapshot extends Record<string, unknown>> {
  key: string;
  principalId: string;
  runtimeEpoch: string;
  conversationId: string;
  streamInstanceId: string;
  seq: number;
  latestSnapshot: TSnapshot;
  latestSnapshotDigest: string;
  lastRevocationWatermark: string;
  events: ProjectionEvent[];
  subscribers: Set<ProjectionSubscriber>;
  piAttach: ProjectionSourceAttach | null;
  invalidated: boolean;
  invalidationReason: string | null;
  rebuilding: Promise<void> | null;
  pendingRefresh: { reason: string; detail?: Record<string, unknown>; forcedEventKind?: "delta" | "partial" } | null;
  refreshGeneration: number;
  lastRefreshAt: number;
}

export function formatCursor(streamInstanceId: string, seq: number): string {
  return `${streamInstanceId}:${seq}`;
}

export function parseCursor(raw: string | null | undefined): { streamInstanceId: string; seq: number } | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const idx = trimmed.lastIndexOf(":");
  if (idx <= 0) return null;
  const streamInstanceId = trimmed.slice(0, idx);
  const seqStr = trimmed.slice(idx + 1);
  if (!/^\d+$/.test(seqStr)) return null;
  const seq = Number(seqStr);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return { streamInstanceId, seq };
}

export class ConversationProjectionHub<TSnapshot extends Record<string, unknown>> {
  readonly #options: ProjectionHubOptions<TSnapshot>;
  readonly #projections = new Map<string, ConversationProjection<TSnapshot>>();
  readonly #initializing = new Map<string, Promise<ConversationProjection<TSnapshot> | null>>();
  #maxHistory: number;
  #maxClientQueue: number;
  readonly #now: () => number;

  constructor(options: ProjectionHubOptions<TSnapshot>) {
    this.#options = options;
    this.#maxHistory = options.maxHistory ?? 200;
    this.#maxClientQueue = options.maxClientQueue ?? 32;
    this.#now = options.now ?? (() => Date.now());
  }

  setLimits(opts: { maxHistory?: number; maxClientQueue?: number }): void {
    if (typeof opts.maxHistory === "number" && opts.maxHistory >= 1) {
      this.#maxHistory = opts.maxHistory;
    }
    if (typeof opts.maxClientQueue === "number" && opts.maxClientQueue >= 1) {
      this.#maxClientQueue = opts.maxClientQueue;
    }
  }

  #keyOf(principalId: string, runtimeEpoch: string, conversationId: string): string {
    return `${principalId}|${runtimeEpoch}|${conversationId}`;
  }

  #readRevocationWatermark(principalId: string, runtimeEpoch: string, conversationId: string): string {
    return (
      this.#options.getRevocationWatermark?.({
        principalId,
        runtimeEpoch,
        conversationId,
      }) ?? ""
    );
  }

  async #getOrInitProjection(
    principalId: string,
    runtimeEpoch: string,
    conversationId: string,
  ): Promise<ConversationProjection<TSnapshot> | null> {
    const key = this.#keyOf(principalId, runtimeEpoch, conversationId);
    const existing = this.#projections.get(key);
    if (existing && !existing.invalidated) {
      return existing;
    }
    const inflight = this.#initializing.get(key);
    if (inflight) return inflight;

    const initPromise = (async (): Promise<ConversationProjection<TSnapshot> | null> => {
      // Buffer-first initialization (Taskbook V05):
      // 1. Attach Pi source observer first and buffer any concurrent changes.
      const bufferedEvents: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
      let initialized = false;
      let projectionRef: ConversationProjection<TSnapshot> | null = null;
      let piAttach: ProjectionSourceAttach | null = null;
      let sourceEndedEarly = false;

      if (this.#options.attachPiObserver) {
        piAttach = await this.#options.attachPiObserver({
          runtimeEpoch,
          conversationId,
          onUpdate: (kind, detail) => {
            if (!initialized || !projectionRef) {
              bufferedEvents.push({ kind, detail });
              return;
            }
            void this.#refreshProjection(projectionRef, kind, detail);
          },
          onEnd: (reason) => {
            sourceEndedEarly = true;
            if (projectionRef) {
              this.#invalidateProjection(projectionRef, `source_observer_ended:${reason}`);
            }
          },
        });
      }

      // 2. Read initial authoritative state from SDK + Governance DB, bound to live revocation watermark.
      let initWatermark = this.#readRevocationWatermark(principalId, runtimeEpoch, conversationId);
      let initialSnap = await this.#options.buildSnapshot({
        principalId,
        runtimeEpoch,
        conversationId,
      });
      if (!initialSnap) {
        piAttach?.detach();
        return null;
      }
      const postInitWatermark = this.#readRevocationWatermark(principalId, runtimeEpoch, conversationId);
      if (postInitWatermark !== initWatermark) {
        initWatermark = postInitWatermark;
        initialSnap = await this.#options.buildSnapshot({
          principalId,
          runtimeEpoch,
          conversationId,
        });
        if (!initialSnap) {
          piAttach?.detach();
          return null;
        }
      }

      const streamInstanceId = `str_${randomUUID().slice(0, 12)}`;
      const seq = 1;
      const stampedSnap = {
        ...initialSnap,
        streamInstanceId,
        seq,
        cursor: formatCursor(streamInstanceId, seq),
        snapshotVersion: seq,
      } as TSnapshot;

      const proj: ConversationProjection<TSnapshot> = {
        key,
        principalId,
        runtimeEpoch,
        conversationId,
        streamInstanceId,
        seq,
        latestSnapshot: stampedSnap,
        latestSnapshotDigest: canonicalJson(initialSnap),
        lastRevocationWatermark: initWatermark,
        events: [
          {
            seq,
            streamInstanceId,
            event: "snapshot",
            cursor: formatCursor(streamInstanceId, seq),
            occurredAt: this.#now(),
            revocationWatermark: initWatermark,
            payload: stampedSnap,
          },
        ],
        subscribers: new Set(),
        piAttach,
        invalidated: sourceEndedEarly,
        invalidationReason: sourceEndedEarly ? "source_observer_ended" : null,
        rebuilding: null,
        pendingRefresh: null,
        refreshGeneration: 0,
        lastRefreshAt: this.#now(),
      };

      projectionRef = proj;
      initialized = true;
      this.#projections.set(key, proj);

      // 3. Reconcile any buffered changes that occurred during initial state load.
      if (bufferedEvents.length > 0 && !proj.invalidated) {
        await this.#refreshProjection(proj, "buffered_reconcile");
      }

      return proj;
    })();

    this.#initializing.set(key, initPromise);
    try {
      return await initPromise;
    } finally {
      this.#initializing.delete(key);
    }
  }

  async getSnapshotAndCursor(params: {
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
  }): Promise<ProjectionSnapshotEnvelope<TSnapshot> | null> {
    const proj = await this.#getOrInitProjection(
      params.principalId,
      params.runtimeEpoch,
      params.conversationId,
    );
    if (!proj) return null;
    // Always reconcile latest committed governance/SDK state before copying snapshot & cursor atomically
    await this.#refreshProjection(proj, "snapshot_read");
    if (proj.invalidated) {
      // Re-init fresh stream instance after invalidation
      const rebuilt = await this.#getOrInitProjection(
        params.principalId,
        params.runtimeEpoch,
        params.conversationId,
      );
      if (!rebuilt) return null;
      return {
        snapshot: structuredClone(rebuilt.latestSnapshot),
        cursor: formatCursor(rebuilt.streamInstanceId, rebuilt.seq),
        streamInstanceId: rebuilt.streamInstanceId,
        seq: rebuilt.seq,
      };
    }
    return {
      snapshot: structuredClone(proj.latestSnapshot),
      cursor: formatCursor(proj.streamInstanceId, proj.seq),
      streamInstanceId: proj.streamInstanceId,
      seq: proj.seq,
    };
  }

  async notifyConversationChanged(params: {
    runtimeEpoch: string;
    conversationId: string;
    reason?: string;
    eventKind?: "delta" | "partial";
    detail?: Record<string, unknown>;
  }): Promise<void> {
    const targets: Array<ConversationProjection<TSnapshot>> = [];
    for (const proj of this.#projections.values()) {
      if (
        !proj.invalidated &&
        proj.runtimeEpoch === params.runtimeEpoch &&
        proj.conversationId === params.conversationId
      ) {
        targets.push(proj);
      }
    }
    for (const proj of targets) {
      await this.#refreshProjection(
        proj,
        params.reason ?? "governance_mutation",
        params.detail,
        params.eventKind,
      );
    }
  }

  async notifyAllActive(reason = "global_mutation"): Promise<void> {
    const targets = [...this.#projections.values()].filter((p) => !p.invalidated);
    for (const proj of targets) {
      await this.#refreshProjection(proj, reason);
    }
  }

  async #refreshProjection(
    proj: ConversationProjection<TSnapshot>,
    reason: string,
    detail?: Record<string, unknown>,
    forcedEventKind?: "delta" | "partial",
  ): Promise<void> {
    if (proj.invalidated) return;
    // W2-S4: Strictly serialize refreshes per conversation!
    // If a refresh is already in flight, coalesce into pendingRefresh and await the full drain
    // so an older async buildSnapshot() can NEVER publish a higher seq after a newer read!
    if (proj.rebuilding) {
      proj.pendingRefresh = {
        reason,
        detail,
        forcedEventKind: forcedEventKind ?? proj.pendingRefresh?.forcedEventKind,
      };
      await proj.rebuilding;
      return;
    }

    const runLoop = async (): Promise<void> => {
      let curReason = reason;
      let curDetail = detail;
      let curForced = forcedEventKind;

      for (;;) {
        if (proj.invalidated) return;
        const watermarkBefore = this.#readRevocationWatermark(
          proj.principalId,
          proj.runtimeEpoch,
          proj.conversationId,
        );
        if (watermarkBefore !== proj.lastRevocationWatermark) {
          // W2-S2: Immediately purge pre-revocation buffered history and terminate existing streams!
          this.#invalidateProjection(proj, "source_read_revoked");
          return;
        }
        const myGen = ++proj.refreshGeneration;
        const fresh = await this.#options.buildSnapshot({
          principalId: proj.principalId,
          runtimeEpoch: proj.runtimeEpoch,
          conversationId: proj.conversationId,
        });
        if (proj.invalidated) return;
        const watermarkAfter = this.#readRevocationWatermark(
          proj.principalId,
          proj.runtimeEpoch,
          proj.conversationId,
        );
        if (watermarkAfter !== proj.lastRevocationWatermark) {
          this.#invalidateProjection(proj, "source_read_revoked");
          return;
        }
        // If another newer generation somehow advanced, discard stale result
        if (myGen !== proj.refreshGeneration) {
          if (!proj.pendingRefresh) return;
        } else if (!fresh) {
          this.#invalidateProjection(proj, "acl_revoked_or_removed");
          return;
        } else {
          const freshDigest = canonicalJson(fresh);
          if (freshDigest !== proj.latestSnapshotDigest || curForced) {
            const nextSeq = proj.seq + 1;
            const cursor = formatCursor(proj.streamInstanceId, nextSeq);
            const stampedSnap = {
              ...fresh,
              streamInstanceId: proj.streamInstanceId,
              seq: nextSeq,
              cursor,
              snapshotVersion: nextSeq,
            } as TSnapshot;

            const ev: ProjectionEvent = {
              seq: nextSeq,
              streamInstanceId: proj.streamInstanceId,
              event: curForced ?? "delta",
              cursor,
              occurredAt: this.#now(),
              revocationWatermark: watermarkAfter,
              payload: {
                reason: curReason,
                ...(curDetail ? { detail: curDetail } : {}),
                snapshot: stampedSnap,
              },
            };

            proj.seq = nextSeq;
            proj.latestSnapshot = stampedSnap;
            proj.latestSnapshotDigest = freshDigest;
            proj.lastRefreshAt = this.#now();
            proj.events.push(ev);
            if (proj.events.length > this.#maxHistory) {
              proj.events.splice(0, proj.events.length - this.#maxHistory);
            }

            const serialized = JSON.stringify(ev.payload);
            for (const sub of [...proj.subscribers]) {
              this.#enqueueFrame(proj, sub, {
                event: ev.event,
                id: ev.cursor,
                data: serialized,
              });
            }
          }
        }

        const next = proj.pendingRefresh;
        if (!next) break;
        proj.pendingRefresh = null;
        curReason = next.reason;
        curDetail = next.detail;
        curForced = next.forcedEventKind;
      }
    };

    const p = runLoop();
    proj.rebuilding = p;
    try {
      await p;
    } finally {
      if (proj.rebuilding === p) {
        proj.rebuilding = null;
      }
    }
  }

  #enqueueFrame(
    proj: ConversationProjection<TSnapshot>,
    sub: ProjectionSubscriber,
    frame: { event: string; id?: string; data: string },
  ): void {
    if (sub.closed) return;
    if (sub.queue.length >= this.#maxClientQueue) {
      // Slow-client protection: terminate with resync and close subscription
      sub.queue.length = 0;
      sub.queue.push({
        event: "resync",
        data: JSON.stringify({
          reason: "slow_client_queue_overflow",
          streamInstanceId: proj.streamInstanceId,
          currentSeq: proj.seq,
          maxClientQueue: this.#maxClientQueue,
        }),
      });
      sub.closed = true;
      proj.subscribers.delete(sub);
      sub.wake?.();
      return;
    }
    sub.queue.push(frame);
    sub.wake?.();
  }

  /**
   * Test-only deterministic injection for V05: push a synthetic frame (e.g. duplicate seq, skipped seq gap, or partial text)
   * directly into active subscribers of a conversation.
   */
  injectFrameForTest(params: {
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
    event: string;
    id?: string;
    payload: Record<string, unknown>;
  }): number {
    const key = this.#keyOf(params.principalId, params.runtimeEpoch, params.conversationId);
    const proj = this.#projections.get(key);
    if (!proj) return 0;
    const data = JSON.stringify(params.payload);
    let delivered = 0;
    for (const sub of [...proj.subscribers]) {
      this.#enqueueFrame(proj, sub, { event: params.event, id: params.id, data });
      delivered++;
    }
    return delivered;
  }

  async openSubscription(params: {
    tokenDigest: string;
    principalId: string;
    runtimeEpoch: string;
    conversationId: string;
    cursorRaw?: string | null;
  }): Promise<
    | { ok: false; resyncReason: string; streamInstanceId?: string; currentSeq?: number }
    | {
        ok: true;
        subscriber: ProjectionSubscriber;
        unsubscribe: () => void;
        revocationWatermark: string;
      }
  > {
    const preWatermark = this.#readRevocationWatermark(
      params.principalId,
      params.runtimeEpoch,
      params.conversationId,
    );
    const proj = await this.#getOrInitProjection(
      params.principalId,
      params.runtimeEpoch,
      params.conversationId,
    );
    if (!proj) {
      return { ok: false, resyncReason: "forbidden_or_not_found" };
    }

    if (proj.lastRevocationWatermark !== preWatermark) {
      // W2-S2: Revocation occurred before this subscription attached -> purge old history & force resync!
      this.#invalidateProjection(proj, "source_read_revoked");
      return {
        ok: false,
        resyncReason: "source_read_revoked",
        streamInstanceId: proj.streamInstanceId,
        currentSeq: proj.seq,
      };
    }

    // Reconcile latest state so events committed right before subscribe are present in proj.events
    await this.#refreshProjection(proj, "pre_subscribe_sync");
    if (proj.invalidated) {
      return {
        ok: false,
        resyncReason: proj.invalidationReason ?? "projection_invalidated",
        streamInstanceId: proj.streamInstanceId,
        currentSeq: proj.seq,
      };
    }

    const postWatermark = this.#readRevocationWatermark(
      params.principalId,
      params.runtimeEpoch,
      params.conversationId,
    );
    if (postWatermark !== proj.lastRevocationWatermark || postWatermark !== preWatermark) {
      this.#invalidateProjection(proj, "source_read_revoked");
      return {
        ok: false,
        resyncReason: "source_read_revoked",
        streamInstanceId: proj.streamInstanceId,
        currentSeq: proj.seq,
      };
    }

    const queue: Array<{ event: string; id?: string; data: string }> = [];

    if (params.cursorRaw) {
      const parsed = parseCursor(params.cursorRaw);
      if (!parsed) {
        return {
          ok: false,
          resyncReason: "malformed_cursor",
          streamInstanceId: proj.streamInstanceId,
          currentSeq: proj.seq,
        };
      }
      if (parsed.streamInstanceId !== proj.streamInstanceId) {
        return {
          ok: false,
          resyncReason: "stream_instance_changed",
          streamInstanceId: proj.streamInstanceId,
          currentSeq: proj.seq,
        };
      }
      if (parsed.seq > proj.seq) {
        return {
          ok: false,
          resyncReason: "cursor_ahead_of_server",
          streamInstanceId: proj.streamInstanceId,
          currentSeq: proj.seq,
        };
      }
      const oldestSeq = proj.events[0]?.seq ?? proj.seq;
      // If client is behind oldest buffered event - 1, intermediate events were evicted -> force resync!
      if (parsed.seq < oldestSeq - 1) {
        return {
          ok: false,
          resyncReason: "cursor_history_evicted",
          streamInstanceId: proj.streamInstanceId,
          currentSeq: proj.seq,
        };
      }
      // Replay every missed event strictly in order (seq > parsed.seq) ONLY if all match current revocation watermark!
      for (const ev of proj.events) {
        if (ev.seq > parsed.seq) {
          if (ev.revocationWatermark !== postWatermark) {
            this.#invalidateProjection(proj, "source_read_revoked");
            return {
              ok: false,
              resyncReason: "source_read_revoked",
              streamInstanceId: proj.streamInstanceId,
              currentSeq: proj.seq,
            };
          }
          queue.push({
            event: ev.event,
            id: ev.cursor,
            data: JSON.stringify(ev.payload),
          });
        }
      }
    } else {
      // Fresh subscription without cursor gets current authoritative snapshot first
      queue.push({
        event: "snapshot",
        id: formatCursor(proj.streamInstanceId, proj.seq),
        data: JSON.stringify(proj.latestSnapshot),
      });
    }

    const sub: ProjectionSubscriber = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      tokenDigest: params.tokenDigest,
      principalId: params.principalId,
      runtimeEpoch: params.runtimeEpoch,
      conversationId: params.conversationId,
      queue,
      closed: false,
      wake: null,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        proj.subscribers.delete(sub);
        sub.wake?.();
      },
    };
    proj.subscribers.add(sub);

    return {
      ok: true,
      subscriber: sub,
      unsubscribe: () => sub.close(),
      revocationWatermark: postWatermark,
    };
  }

  #invalidateProjection(proj: ConversationProjection<TSnapshot>, reason: string): void {
    if (proj.invalidated) return;
    proj.invalidated = true;
    proj.invalidationReason = reason;
    proj.events.length = 0;
    proj.piAttach?.detach();
    proj.piAttach = null;
    for (const sub of [...proj.subscribers]) {
      sub.queue.length = 0;
      sub.queue.push({
        event: "resync",
        data: JSON.stringify({
          reason,
          streamInstanceId: proj.streamInstanceId,
          currentSeq: proj.seq,
        }),
      });
      sub.closed = true;
      sub.wake?.();
    }
    proj.subscribers.clear();
    this.#projections.delete(proj.key);
  }

  invalidateEpoch(runtimeEpoch: string, reason = "epoch_rotated"): void {
    for (const proj of [...this.#projections.values()]) {
      if (proj.runtimeEpoch === runtimeEpoch) {
        this.#invalidateProjection(proj, reason);
      }
    }
  }

  invalidateConversation(
    params: { principalId: string; runtimeEpoch: string; conversationId: string },
    reason = "source_read_revoked",
  ): void {
    const key = this.#keyOf(params.principalId, params.runtimeEpoch, params.conversationId);
    const proj = this.#projections.get(key);
    if (proj) {
      this.#invalidateProjection(proj, reason);
    }
  }

  closeStreamsForSession(tokenDigest: string): void {
    for (const proj of this.#projections.values()) {
      for (const sub of [...proj.subscribers]) {
        if (sub.tokenDigest === tokenDigest) {
          sub.queue.length = 0;
          sub.closed = true;
          proj.subscribers.delete(sub);
          sub.wake?.();
        }
      }
    }
  }

  closeStreamsForPrincipal(principalId: string): void {
    for (const proj of this.#projections.values()) {
      if (proj.principalId !== principalId) continue;
      for (const sub of [...proj.subscribers]) {
        sub.queue.length = 0;
        sub.closed = true;
        proj.subscribers.delete(sub);
        sub.wake?.();
      }
    }
  }

  closeAll(): void {
    for (const proj of [...this.#projections.values()]) {
      proj.piAttach?.detach();
      for (const sub of [...proj.subscribers]) {
        sub.queue.length = 0;
        sub.closed = true;
        sub.wake?.();
      }
      proj.subscribers.clear();
    }
    this.#projections.clear();
  }
}
