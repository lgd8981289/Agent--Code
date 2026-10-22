"""模型增量按完整段落发布，引用可以跨 token，最终消息才是成功记录。"""

import re


def validate_citations(answer, evidence):
    for id in re.findall(r"\bPOL-[A-Z0-9-]+\b", answer):
        if id not in evidence:
            raise ValueError(f"回答引用了未经核验的资料：{id}")


class AnswerStream:
    def __init__(self, evidence, emit):
        self.evidence, self.emit, self.pending = evidence, emit, ""

    def reset(self):
        self.pending = ""
        self.emit({"type": "answer.reset"})

    def push(self, text):
        self.pending += text
        while "\n\n" in self.pending:
            end = self.pending.index("\n\n") + 2
            self.publish(self.pending[:end])
            self.pending = self.pending[end:]

    def finish(self):
        self.publish(self.pending)
        self.pending = ""

    def publish(self, text):
        if text:
            validate_citations(text, self.evidence)
            self.emit({"type": "answer.delta", "text": text})
