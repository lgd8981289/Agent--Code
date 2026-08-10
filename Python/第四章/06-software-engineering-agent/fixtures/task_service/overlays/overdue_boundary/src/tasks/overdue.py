from datetime import datetime

from .task_types import TaskRecord


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def is_task_overdue(task: TaskRecord, now: datetime) -> bool:
    """判断一条未完成任务是否已经超过截止时间。"""

    return task["status"] != "done" and parse_iso(task["due_at"]) <= now
