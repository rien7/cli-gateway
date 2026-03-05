export type BufferedSinkState = {
  text: string;
  messageId: string | null;
};

export type BufferedSink = {
  sendText: (delta: string) => Promise<void>;
  breakMessage: () => Promise<void>;
  flush: () => Promise<void>;
  getState: () => BufferedSinkState;
};

export function createBufferedSink(params: {
  maxLen: number;
  flushIntervalMs: number;
  send: (text: string) => Promise<{ id: string }>;
  edit: (id: string, text: string) => Promise<void>;
  initialState?: BufferedSinkState;
}): BufferedSink {
  let currentText = params.initialState?.text ?? '';
  let currentMessageId: string | null = params.initialState?.messageId ?? null;
  let flushTimer: NodeJS.Timeout | null = null;
  let flushInFlight: Promise<void> | null = null;

  async function runFlush(): Promise<void> {
    if (!currentText) return;

    if (!currentMessageId) {
      const res = await params.send(currentText);
      currentMessageId = res.id;
      return;
    }

    try {
      await params.edit(currentMessageId, currentText);
    } catch (error) {
      if (isNoopEditError(error)) {
        return;
      }
      const res = await params.send(currentText);
      currentMessageId = res.id;
    }
  }

  async function doFlush(): Promise<void> {
    if (flushInFlight) {
      await flushInFlight;
      return;
    }

    flushInFlight = runFlush().finally(() => {
      flushInFlight = null;
    });
    await flushInFlight;
  }

  function clearScheduledFlush(): void {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void doFlush().catch(() => {
        // best-effort background flush; errors surface on explicit flush()
      });
    }, params.flushIntervalMs);
  }

  async function sendText(delta: string): Promise<void> {
    if (!delta) return;

    let remain = delta;

    while (remain.length > 0) {
      const capacity = params.maxLen - currentText.length;
      if (capacity <= 0) {
        clearScheduledFlush();
        await doFlush();
        currentText = '';
        currentMessageId = null;
        continue;
      }

      const next = remain.slice(0, capacity);
      currentText += next;
      remain = remain.slice(next.length);

      if (currentText.length >= params.maxLen) {
        clearScheduledFlush();
        await doFlush();
        currentText = '';
        currentMessageId = null;
      }
    }

    if (currentText) {
      scheduleFlush();
    }
  }

  return {
    sendText,
    breakMessage: async () => {
      clearScheduledFlush();
      await doFlush();
      currentText = '';
      currentMessageId = null;
    },
    flush: async () => {
      clearScheduledFlush();
      await doFlush();
    },
    getState: () => ({ text: currentText, messageId: currentMessageId }),
  };
}

function isNoopEditError(error: unknown): boolean {
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';
  const lowered = message.toLowerCase();

  return (
    lowered.includes('message is not modified') ||
    lowered.includes('message not modified') ||
    lowered.includes('content must be different')
  );
}
