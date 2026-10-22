import type { ConsultationEvent, Policy } from "../shared/types.js";

export function validateCitations(answer: string, evidence: Map<string, Policy>) {
  for (const match of answer.matchAll(/\bPOL-[A-Z0-9-]+\b/g)) {
    if (!evidence.has(match[0]))
      throw new Error(`回答引用了未经核验的资料：${match[0]}`);
  }
}

/** 真实模型增量按段落发布；引用可能跨 token，不能在半个编号时判断。 */
export class AnswerStream {
  private pending = "";
  constructor(
    private readonly evidence: Map<string, Policy>,
    private readonly emit: (event: ConsultationEvent) => void,
  ) {}
  reset() {
    this.pending = "";
    this.emit({ type: "answer.reset" });
  }
  push(text: string) {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf("\n\n")) >= 0) {
      this.publish(this.pending.slice(0, end + 2));
      this.pending = this.pending.slice(end + 2);
    }
  }
  finish() {
    this.publish(this.pending);
    this.pending = "";
  }
  private publish(text: string) {
    if (!text) return;
    validateCitations(text, this.evidence);
    this.emit({ type: "answer.delta", text });
  }
}
