export type InitializeParams = {
  protocolVersion: number;
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  clientInfo?: { name: string; title?: string; version?: string };
};

export type InitializeResult = {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
  agentInfo?: { name: string; title?: string; version?: string };
  authMethods?: Array<{ id: string; name: string; description?: string }>;
};

export type NewSessionParams = {
  cwd: string;
  mcpServers: unknown[];
};

export type ModelInfo = {
  modelId: string;
  name: string;
  description?: string;
};

export type SessionModelState = {
  currentModelId: string;
  availableModels: ModelInfo[];
};

export type SessionConfigSelectOption = {
  value: string;
  name: string;
  description?: string;
};

export type SessionConfigSelectGroup = {
  group: string;
  name: string;
  options: SessionConfigSelectOption[];
};

export type SessionConfigSelectOptions =
  | SessionConfigSelectOption[]
  | SessionConfigSelectGroup[];

export type SessionConfigOption =
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: 'select';
      currentValue: string;
      options: SessionConfigSelectOptions;
    }
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: 'boolean';
      currentValue: boolean;
    }
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: string;
      [key: string]: unknown;
    };

export type NewSessionResult = {
  sessionId: string;
  availableModes?: Array<{ id: string; name: string; description?: string }>;
  models?: SessionModelState;
  configOptions?: SessionConfigOption[];
};

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string };

export type PromptParams = {
  sessionId: string;
  prompt: ContentBlock[];
};

export type PromptResult = {
  stopReason: string;
};

export type SessionUpdateNotification = {
  sessionId: string;
  update: any;
};

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: string;
};

export type RequestPermissionParams = {
  sessionId: string;
  toolCall: any;
  options: PermissionOption[];
};

export type RequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

export type RequestPermissionResult = {
  outcome: RequestPermissionOutcome;
};

export type SetSessionConfigOptionParams = {
  sessionId: string;
  configId: string;
  value:
    | string
    | {
        type: 'boolean';
        value: boolean;
      };
};

export type SetSessionConfigOptionResult = {
  configOptions: SessionConfigOption[];
};

export type FsReadTextFileParams = {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
};

export type FsReadTextFileResult = {
  content: string;
};

export type FsWriteTextFileParams = {
  sessionId: string;
  path: string;
  content: string;
};

export type TerminalCreateParams = {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Array<{ name: string; value: string }>;
  outputByteLimit?: number | null;
};

export type TerminalCreateResult = {
  terminalId: string;
};

export type TerminalOutputParams = {
  sessionId: string;
  terminalId: string;
};

export type TerminalExitStatus = {
  exitCode?: number | null;
  signal?: string | null;
};

export type TerminalOutputResult = {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus | null;
};

export type TerminalWaitForExitParams = {
  sessionId: string;
  terminalId: string;
};

export type TerminalWaitForExitResult = {
  exitCode?: number | null;
  signal?: string | null;
};

export type TerminalKillParams = {
  sessionId: string;
  terminalId: string;
};

export type TerminalReleaseParams = {
  sessionId: string;
  terminalId: string;
};
