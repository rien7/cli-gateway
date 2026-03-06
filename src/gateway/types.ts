export type DeliveryState = {
  text: string;
  messageId: string | null;
};

export type UiMode = 'verbose' | 'summary';
export type ToolUiStage = 'start' | 'update' | 'complete';

export type PermissionUiRequest = {
  uiMode: UiMode;
  sessionKey: string;
  requestId: string;
  toolTitle: string;
  toolKind: string | null;
  toolName?: string;
  toolArgs?: unknown;
};

export type UiEvent =
  | {
      kind: 'plan' | 'task';
      mode: UiMode;
      title: string;
      detail?: string;
    }
  | {
      kind: 'tool';
      mode: UiMode;
      title: string;
      detail?: string;
      toolCallId?: string;
      stage?: ToolUiStage;
      status?: string;
    };

export type OutboundSink = {
  // Reserved for agent assistant content chunks.
  // Telegram private chats stream this via sendMessageDraft.
  sendAgentText?: (text: string) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  // Force subsequent assistant chunks to continue in a new outgoing message.
  // Useful when switching between agent text and tool UI updates.
  breakTextStream?: () => Promise<void>;
  flush?: () => Promise<void>;
  getDeliveryState?: () => DeliveryState;

  requestPermission?: (req: PermissionUiRequest) => Promise<void>;
  sendUi?: (event: UiEvent) => Promise<void>;
};
