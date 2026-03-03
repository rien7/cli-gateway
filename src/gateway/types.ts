export type DeliveryState = {
  text: string;
  messageId: string | null;
};

export type PermissionUiRequest = {
  sessionKey: string;
  requestId: string;
  toolTitle: string;
  toolKind: string | null;
};

export type OutboundSink = {
  sendText: (text: string) => Promise<void>;
  flush?: () => Promise<void>;
  getDeliveryState?: () => DeliveryState;

  requestPermission?: (req: PermissionUiRequest) => Promise<void>;
};
