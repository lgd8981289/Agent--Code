"""所有入口共用的权限、金额、版本和审批规则，MCP 业务端再次执行校验。"""

from .common import require

CASE_STATUSES = ["waiting_review", "needs_materials", "approved", "executing", "unknown", "completed", "rejected", "cancelled"]
STATUS_LABELS = dict(zip(CASE_STATUSES, ["等待审核", "补充材料", "审核通过", "执行中", "结果待核对", "处理完成", "已拒绝", "已撤回"]))


def assert_owner(actor, value, allow_reviewer=False):
    require(actor["tenantId"] == value["tenantId"] and ((allow_reviewer and actor["role"] == "reviewer") or actor["id"] == value["userId"]), "无权访问这条记录", 403)


def assert_customer(actor):
    require(actor["role"] == "customer", "请使用客户身份操作", 403)


def assert_reviewer(actor):
    require(actor["role"] == "reviewer", "仅企业审核人员可以审批", 403)


def assert_version(item, version):
    require(item["version"] == version, "申请版本已经变化，请刷新后审核当前版本", 409)


def assert_amount(amount, order):
    # bool 是 Python int 的子类，必须显式排除；同时保持 JS 安全整数上限。
    require(type(amount) is int and 0 < amount <= min(2**53 - 1, order["paidCents"] - order["refundedCents"]), "退款金额必须大于零，且不能超过订单剩余可退金额")


def approval_for(item):
    return next((r for r in reversed(item["reviews"]) if r["version"] == item["version"]), None)


def request_key(item):
    return f"refund:{item['id']}:v{item['version']}"


def assert_executable(item, order, receipt=None):
    review = approval_for(item)
    require(review and review["decision"] == "approve" and item["status"] in ("approved", "executing", "unknown", "completed"), "当前版本没有有效审批，不能执行退款", 403)
    if receipt:
        require(all(receipt[k] == item[v] for k, v in (("caseId", "id"), ("version", "version"), ("amountCents", "amountCents"), ("orderId", "orderId"))), "业务回执与当前申请不一致，请人工核对", 409)
    elif item["status"] != "completed":
        assert_amount(item["amountCents"], order)


def can_edit(item):
    require(item["status"] in ("waiting_review", "needs_materials"), "当前申请已进入执行或终态，不能修改", 409)


def assert_review_note(decision, note):
    require(decision == "approve" or len(note.strip()) >= 3, "退回补充或拒绝时，请填写至少 3 个字的具体原因")
