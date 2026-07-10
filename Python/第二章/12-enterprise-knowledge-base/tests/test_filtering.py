import unittest

from app.filtering import (
    build_document_filter,
    build_permission_filter,
    escape_filter_value,
)
from app.models import DemoUser


class FilteringTest(unittest.TestCase):
    def setUp(self):
        self.employee = DemoUser(
            token="token",
            id="user-1",
            name="测试用户",
            tenant_id="bluewhale",
            tenant_name="蓝鲸科技",
            department_id="finance",
            department_name="财务部",
            role="employee",
        )

    def test_employee_permission_filter(self):
        self.assertEqual(
            build_permission_filter(self.employee),
            'tenant_id == "bluewhale" and is_active == true and (visibility == "company" or department_id == "finance")',
        )

    def test_admin_still_limited_by_tenant(self):
        admin = DemoUser(**{**self.employee.__dict__, "role": "admin"})
        self.assertEqual(
            build_permission_filter(admin),
            'tenant_id == "bluewhale" and is_active == true',
        )

    def test_document_filter_can_include_inactive_versions(self):
        self.assertEqual(
            build_document_filter("bluewhale", "doc-1"),
            'tenant_id == "bluewhale" and document_id == "doc-1"',
        )

    def test_escape_filter_value(self):
        self.assertEqual(escape_filter_value('a"b\\c'), 'a\\"b\\\\c')


if __name__ == "__main__":
    unittest.main()

