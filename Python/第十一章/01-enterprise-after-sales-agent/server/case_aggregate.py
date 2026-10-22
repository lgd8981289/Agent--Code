"""申请只在当前版本确认、审批；材料和内容变化会使调查失效。"""

from .common import now, uid, require
from .domain import (assert_amount, assert_customer, assert_executable, assert_owner,
                     assert_reviewer, assert_review_note, assert_version, can_edit)


class AfterSalesAggregate:
    def __init__(self, value):
        self.value = value

    def changed(self):
        self.value["updatedAt"] = now()

    def invalidate_investigation(self, reason):
        if self.value.get("investigation"):
            self.value["investigation"].update(status="stale", staleReason=reason)

    def revise(self, actor, version, order, amount_cents, reason, material_ids):
        assert_customer(actor)
        assert_owner(actor, self.value)
        can_edit(self.value)
        assert_version(self.value, version)
        assert_amount(amount_cents, order)
        self.value["version"] += 1
        self.value.update(amountCents=amount_cents, reason=reason, materialIds=material_ids, status="waiting_review")
        self.invalidate_investigation("申请内容已经修改，请对当前版本重新调查")
        self.changed()

    def change_material(self, actor, version, id, remove):
        assert_customer(actor)
        assert_owner(actor, self.value)
        can_edit(self.value)
        assert_version(self.value, version)
        ids = self.value["materialIds"]
        self.value["materialIds"] = [v for v in ids if v != id] if remove else list(dict.fromkeys([*ids, id]))
        self.value["version"] += 1
        self.value["status"] = "needs_materials"
        self.invalidate_investigation("材料已经修改，请对当前版本重新调查")
        self.changed()

    def review(self, actor, input):
        assert_reviewer(actor)
        assert_owner(actor, self.value, True)
        assert_version(self.value, input["version"])
        assert_review_note(input["decision"], input["note"])
        require(self.value["status"] == "waiting_review", "这份申请当前不在待审核状态", 409)
        self.value["reviews"].append(dict(id=uid(), **input, reviewerId=actor["id"], at=now()))
        self.value["reviews"][-1]["note"] = input["note"].strip()
        self.value["status"] = {"approve": "approved", "revise": "needs_materials", "reject": "rejected"}[input["decision"]]
        self.changed()

    def cancel(self, actor, version, reason):
        assert_customer(actor)
        assert_owner(actor, self.value)
        assert_version(self.value, version)
        if self.value["status"] == "cancelled":
            return False
        can_edit(self.value)
        self.value["status"] = "cancelled"
        self.changed()
        self.value.update(cancelledAt=self.value["updatedAt"], cancellationReason=reason.strip())
        return True

    def attach_investigation(self, report):
        require(report["caseVersion"] == self.value["version"], "调查对应旧版本，请重新调查当前申请", 409)
        self.value["investigation"] = report
        self.changed()

    def complete(self, order, receipt):
        assert_executable(self.value, order, receipt)
        self.value.update(refund=receipt, status="completed", lastError=None)
        self.changed()
