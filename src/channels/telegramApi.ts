export type TelegramApiResult<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string };

export async function callTelegram<T>(
  token: string,
  method: string,
  payload: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<TelegramApiResult<T>> {
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return (await res.json()) as TelegramApiResult<T>;
}

export async function sendMessageDraft(
  token: string,
  params: {
    chatId: number;
    threadId: number | null;
    draftId: number;
    text: string;
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const payload: any = {
    chat_id: params.chatId,
    draft_id: params.draftId,
    text: params.text,
  };
  if (params.threadId) payload.message_thread_id = params.threadId;
  if (params.parseMode) payload.parse_mode = params.parseMode;

  const json = await callTelegram<boolean>(
    token,
    'sendMessageDraft',
    payload,
    fetchFn,
  );

  if (!json.ok) {
    throw new Error(
      `sendMessageDraft failed: ${json.error_code ?? ''} ${json.description ?? ''}`,
    );
  }
}

export async function setMessageReaction(
  token: string,
  params: {
    chatId: number;
    messageId: number;
    emoji: string;
    isBig?: boolean;
  },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const payload: any = {
    chat_id: params.chatId,
    message_id: params.messageId,
    reaction: [{ type: 'emoji', emoji: params.emoji }],
  };
  if (params.isBig !== undefined) payload.is_big = params.isBig;

  const json = await callTelegram<boolean>(
    token,
    'setMessageReaction',
    payload,
    fetchFn,
  );

  if (!json.ok) {
    throw new Error(
      `setMessageReaction failed: ${json.error_code ?? ''} ${json.description ?? ''}`,
    );
  }
}
