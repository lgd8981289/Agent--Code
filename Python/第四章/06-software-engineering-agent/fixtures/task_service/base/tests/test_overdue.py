from datetime import datetime
import unittest

from src.tasks.overdue import is_task_overdue

TASK = {
    "id": "T-2001",
    "title": "验证截止时间边界",
    "status": "todo",
    "priority": "high",
    "due_at": "2026-08-03T10:00:00.000Z",
}


class OverdueTest(unittest.TestCase):
    def test_returns_true_after_the_due_time(self):
        self.assertTrue(is_task_overdue(TASK, datetime.fromisoformat("2026-08-03T10:00:01+00:00")))

    def test_returns_false_for_completed_tasks(self):
        self.assertFalse(
            is_task_overdue(
                {**TASK, "status": "done"},
                datetime.fromisoformat("2026-08-03T10:00:01+00:00"),
            )
        )


if __name__ == "__main__":
    unittest.main()
