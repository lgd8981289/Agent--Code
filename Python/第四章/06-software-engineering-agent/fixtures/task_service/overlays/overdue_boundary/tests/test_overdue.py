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
    def test_does_not_mark_a_completed_task_overdue(self):
        self.assertFalse(
            is_task_overdue(
                {**TASK, "status": "done"},
                datetime.fromisoformat("2026-08-03T10:00:01+00:00"),
            )
        )

    def test_does_not_mark_a_task_overdue_at_the_exact_due_time(self):
        self.assertFalse(is_task_overdue(TASK, datetime.fromisoformat("2026-08-03T10:00:00+00:00")))

    def test_marks_a_task_overdue_after_the_due_time(self):
        self.assertTrue(is_task_overdue(TASK, datetime.fromisoformat("2026-08-03T10:00:01+00:00")))


if __name__ == "__main__":
    unittest.main()
