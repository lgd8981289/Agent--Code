from typing import Literal, NotRequired, TypedDict

TaskStatus = Literal["todo", "in_progress", "done"]
TaskPriority = Literal["low", "medium", "high"]


class TaskRecord(TypedDict):
    id: str
    title: str
    status: TaskStatus
    priority: TaskPriority
    due_at: str


class TaskFilters(TypedDict, total=False):
    status: NotRequired[TaskStatus]
