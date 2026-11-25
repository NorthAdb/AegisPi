import {
  NOOP_TELEMETRY_METRICS,
  type SpanAttributes,
  type SpanLink,
  type SpanOptions,
  type SpanStatus,
  type TelemetryContext,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";

export interface PhaseAttribution {
  taskId: number;
  taskName: string;
  phase: string;
  invocationKind: string;
  attempt: number | undefined;
  resumed: boolean;
}

export class HostPhaseTelemetry implements TelemetryContext {
  readonly metrics = NOOP_TELEMETRY_METRICS;
  readonly #spanAttributions = new WeakMap<object, PhaseAttribution>();
  readonly #onPhaseStart?: (attr: PhaseAttribution) => void;

  constructor(options?: { onPhaseStart?: (attr: PhaseAttribution) => void }) {
    this.#onPhaseStart = options?.onPhaseStart;
  }

  resolve(telemetry: TelemetryContext | undefined): PhaseAttribution | undefined {
    if (!telemetry || typeof telemetry !== "object") return undefined;
    return this.#spanAttributions.get(telemetry);
  }

  #createSpan(options: SpanOptions, inherited?: PhaseAttribution): TelemetrySpan {
    let attribution = inherited;
    if (options.name === "pi.durable.phase" && options.attributes) {
      const taskId = options.attributes["task.id"];
      const taskName = options.attributes["task.name"];
      const phase = options.attributes["phase"];
      const kind = options.attributes["kind"];
      const attempt = options.attributes["attempt"];
      const resumed = options.attributes["resumed"];
      if (typeof taskId === "number" && typeof taskName === "string" && typeof phase === "string") {
        attribution = {
          taskId,
          taskName,
          phase,
          invocationKind: typeof kind === "string" ? kind : "run",
          attempt: typeof attempt === "number" ? attempt : undefined,
          resumed: Boolean(resumed),
        };
        this.#onPhaseStart?.(attribution);
      }
    }

    const self = this;
    const span: TelemetrySpan = {
      metrics: NOOP_TELEMETRY_METRICS,
      async startSpan<T>(childOptions: SpanOptions, callback: (child: TelemetrySpan) => T | Promise<T>): Promise<T> {
        const child = self.#createSpan(childOptions, attribution);
        return await callback(child);
      },
      addLink(_link: SpanLink): void {},
      addEvent(_name: string, _attributes?: SpanAttributes): void {},
      setAttributes(_attributes: SpanAttributes): void {},
      setStatus(_status: SpanStatus): void {},
    };

    if (attribution) {
      this.#spanAttributions.set(span, attribution);
    }
    return span;
  }

  async startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const span = this.#createSpan(options, undefined);
    return await callback(span);
  }
}
