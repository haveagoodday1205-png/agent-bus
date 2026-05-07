export interface AgentBusClientOptions {
  gatewayUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class AgentBusError extends Error {
  status: number;
  statusText: string;
  body: unknown;
}

export class AgentBusClient {
  constructor(options?: AgentBusClientOptions);
  health(): Promise<any>;
  wellKnown(): Promise<any>;
  manifest(): Promise<any>;
  agents(): Promise<any[]>;
  nodes(): Promise<any[]>;
  rooms(): Promise<any[]>;
  room(roomId: string): Promise<any>;
  createRoom(body: Record<string, unknown>): Promise<any>;
  wakeRoom(roomId: string, body?: Record<string, unknown>): Promise<any>;
  messageRoom(roomId: string, body?: Record<string, unknown>): Promise<any>;
  models(): Promise<any>;
  chatCompletion(body: Record<string, unknown>): Promise<any>;
  response(body: Record<string, unknown>): Promise<any>;
  agentChat(agentId: string, messages: any[], options?: Record<string, unknown>): Promise<any>;
  agentResponse(agentId: string, input: unknown, options?: Record<string, unknown>): Promise<any>;
  exportRoomEvents(roomId: string, options?: { reportsOnly?: boolean }): Promise<any>;
  request(pathname: string, options?: Record<string, unknown>): Promise<any>;
}

export function agentModel(agentId: string): string;
export function roomEventBundle(room: any, options?: { reportsOnly?: boolean }): any;
export function replayRoomEvents(bundle: any): any;
