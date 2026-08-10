from .task_service import TaskService
from .task_types import TaskStatus


class TaskController:
    def __init__(self, task_service: TaskService):
        self.task_service = task_service

    def list_tasks(self, status: TaskStatus | None = None):
        return self.task_service.list({"status": status})
