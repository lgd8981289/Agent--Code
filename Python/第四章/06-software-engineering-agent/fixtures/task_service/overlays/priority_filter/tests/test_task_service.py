import unittest

from src.tasks.task_service import TaskService


class TaskServiceTest(unittest.TestCase):
    def test_filters_tasks_by_status(self):
        service = TaskService()
        self.assertEqual(len(service.list({"status": "todo"})), 1)

    def test_filters_tasks_by_priority(self):
        service = TaskService()
        result = service.list({"priority": "high"})

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "T-1001")


if __name__ == "__main__":
    unittest.main()
