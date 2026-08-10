from .task_types import TaskFilters, TaskRecord


class TaskService:
    def __init__(self):
        self.tasks: list[TaskRecord] = [
            {
                "id": "T-1001",
                "title": "补充 Agent Runtime 测试",
                "status": "in_progress",
                "priority": "high",
                "due_at": "2026-08-05T10:00:00.000Z",
            },
            {
                "id": "T-1002",
                "title": "整理课程截图",
                "status": "todo",
                "priority": "medium",
                "due_at": "2026-08-08T10:00:00.000Z",
            },
            {
                "id": "T-1003",
                "title": "发布第四章代码",
                "status": "done",
                "priority": "low",
                "due_at": "2026-08-01T10:00:00.000Z",
            },
        ]

    def list(self, filters: TaskFilters | None = None) -> list[TaskRecord]:
        filters = filters or {}
        return [
            task
            for task in self.tasks
            if not filters.get("status") or task["status"] == filters["status"]
        ]
