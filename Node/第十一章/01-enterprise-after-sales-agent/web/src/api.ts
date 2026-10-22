import type { ConsultationEvent, Conversation } from "../../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError("服务暂时无法连接，请稍后重试", response.status);
  }
  if (!response.ok)
    throw new ApiError(
      typeof value === "object" &&
        value !== null &&
        "message" in value &&
        typeof value.message === "string"
        ? value.message
        : `请求失败 ${response.status}`,
      response.status,
    );
  return value as T;
}
export const money = (cents: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
    cents / 100,
  );

export async function streamMessage(
  id: string,
  message: string,
  onEvent: (event: ConsultationEvent) => void,
  signal?: AbortSignal,
): Promise<Conversation> {
  const response = await fetch(`/api/conversations/${id}/messages/stream`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message }),
    signal,
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new ApiError(
      typeof value === "object" &&
        value !== null &&
        "message" in value &&
        typeof value.message === "string"
        ? value.message
        : `请求失败 ${response.status}`,
      response.status,
    );
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    throw new Error("服务未返回流式响应，请重新连接");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as ConsultationEvent;
        if (event.type === "error") throw new Error(event.message);
        onEvent(event);
        if (event.type === "done") return event.conversation;
      }
      if (done) throw new Error("回复连接已中断，请刷新查看已保存的处理结果");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const time = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
