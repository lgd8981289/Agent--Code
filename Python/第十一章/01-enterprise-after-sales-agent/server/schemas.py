"""保持页面 camelCase 请求字段；身份、租户和金额审批都不从模型结果绑定。"""

from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt

Mode = Literal["replay", "ai"]
Positive = Annotated[StrictInt, Field(gt=0)]
Status = Literal["waiting_review", "needs_materials", "approved", "executing", "unknown", "completed", "rejected", "cancelled"]


class Input(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)


class Login(Input):
    accountId: str


class Create(Input):
    mode: Mode


class Rename(Input):
    title: Annotated[str, Field(min_length=1, max_length=50)]


class Send(Input):
    message: Annotated[str, Field(min_length=1, max_length=2000)]


class Confirm(Input):
    observation: Annotated[str, Field(min_length=1, max_length=2000)]
    version: Positive | None = None


class Remove(Input):
    version: Positive | None = None


class Mutation(Input):
    version: Positive
    amountCents: Positive
    reason: Annotated[str, Field(min_length=3, max_length=1500)]


class Submit(Input):
    orderId: Annotated[str, Field(min_length=1, max_length=30)]
    draftVersion: Annotated[StrictInt, Field(ge=0)]
    amountCents: Positive
    reason: Annotated[str, Field(min_length=3, max_length=1500)]
    fault: Literal["none", "timeout_after_commit", "before_submit"] = "none"


class Review(Input):
    version: Positive
    decision: Literal["approve", "revise", "reject"]
    note: Annotated[str, Field(max_length=1000)] = ""


class Cancel(Input):
    version: Positive
    reason: Annotated[str, Field(min_length=3, max_length=500)]


class Preference(Input):
    value: Annotated[str, Field(min_length=1, max_length=100)]


class Speak(Input):
    text: Annotated[str, Field(min_length=1, max_length=1500)]


class Evaluate(Input):
    version: Literal["baseline", "current"] = "current"
    mode: Mode = "replay"
    model: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    prompt: Annotated[str, Field(min_length=1, max_length=6000)] | None = None


class Page(Input):
    query: Annotated[str, Field(max_length=100)] = ""
    status: Status | None = None
    page: Annotated[int, Field(ge=1, le=100000)] = 1
    pageSize: Annotated[int, Field(ge=1, le=50)] = 20
    sort: Literal["updated", "oldest"] = "updated"
