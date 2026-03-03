import http from 'node:http';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';

export type FeishuController = {
  createSink: (chatId: string, userId: string) => OutboundSink;
};

export async function startFeishu(
  router: GatewayRouter,
  config: AppConfig,
): Promise<FeishuController | null> {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    log.info('Feishu disabled: missing FEISHU_APP_ID/FEISHU_APP_SECRET');
    return null;
  }

  const api = new FeishuApi({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/feishu/events') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      const body = await readJsonBody(req);

      const challenge = body?.challenge as string | undefined;
      if (challenge) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ challenge }));
        return;
      }

      if (config.feishuVerificationToken) {
        const token =
          (body?.token as string | undefined) ??
          (body?.header?.token as string | undefined);
        if (!token || token !== config.feishuVerificationToken) {
          res.statusCode = 403;
          res.end('invalid token');
          return;
        }
      }

      res.statusCode = 200;
      res.end('ok');

      const eventType = body?.header?.event_type as string | undefined;
      if (eventType !== 'im.message.receive_v1') return;

      const message = body?.event?.message as any;
      const sender = body?.event?.sender as any;

      const chatId = String(message?.chat_id ?? '');
      const messageType = String(message?.message_type ?? '');
      const contentRaw = String(message?.content ?? '');

      const openId =
        String(sender?.sender_id?.open_id ?? '') ||
        String(sender?.sender_id?.user_id ?? '') ||
        'unknown';

      if (!chatId || messageType !== 'text') return;

      let text = '';
      try {
        const parsed = JSON.parse(contentRaw);
        text = String(parsed?.text ?? '').trim();
      } catch {
        text = '';
      }

      if (!text) return;

      const key: ConversationKey = {
        platform: 'feishu',
        chatId,
        threadId: null,
        userId: openId,
      };

      const sink = createFeishuSink(api, chatId);

      void router.handleUserMessage(key, text, sink).catch((error) => {
        log.error('Feishu event handler error', error);
      });
    } catch (error) {
      try {
        res.statusCode = 500;
        res.end('error');
      } catch {
        // ignore
      }
      log.error('Feishu webhook error', error);
    }
  });

  server.listen(config.feishuListenPort, () => {
    log.info('Feishu webhook server listening', {
      port: config.feishuListenPort,
      path: '/feishu/events',
    });
  });

  return {
    createSink: (chatId: string, _userId: string) => createFeishuSink(api, chatId),
  };
}

function createFeishuSink(api: FeishuApi, chatId: string): OutboundSink {
  let buffer = '';

  return {
    sendText: async (delta: string) => {
      if (!delta) return;
      buffer += delta;
    },
    flush: async () => {
      const text = buffer.trim();
      if (!text) return;
      buffer = '';
      await api.sendTextMessage({ chatId, text });
    },
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

class FeishuApi {
  private readonly appId: string;
  private readonly appSecret: string;

  private cachedToken:
    | { token: string; expiresAtMs: number }
    | null = null;

  constructor(params: { appId: string; appSecret: string }) {
    this.appId = params.appId;
    this.appSecret = params.appSecret;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() + 60_000 < this.cachedToken.expiresAtMs) {
      return this.cachedToken.token;
    }

    const res = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      },
    );

    const json = (await res.json()) as any;
    if (!res.ok || json?.code) {
      throw new Error(
        `feishu token error: http=${res.status} code=${json?.code} msg=${json?.msg}`,
      );
    }

    const token = String(json?.tenant_access_token ?? '');
    const expire = Number(json?.expire ?? 0);

    if (!token || !expire) {
      throw new Error('feishu token error: missing token/expire');
    }

    this.cachedToken = {
      token,
      expiresAtMs: Date.now() + expire * 1000,
    };

    return token;
  }

  async sendTextMessage(params: { chatId: string; text: string }): Promise<void> {
    const token = await this.getTenantAccessToken();

    const res = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: params.chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: params.text }),
        }),
      },
    );

    const json = (await res.json()) as any;
    if (!res.ok || json?.code) {
      throw new Error(
        `feishu send error: http=${res.status} code=${json?.code} msg=${json?.msg}`,
      );
    }
  }
}
