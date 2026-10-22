"""MCP 返回值同样是不可信输入，不能用类型注解代替运行时校验。"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID
from pydantic import BaseModel, Field, StrictInt, TypeAdapter, ValidationError, field_validator

Nonnegative = Annotated[StrictInt, Field(ge=0)]
Text = Annotated[str, Field(min_length=1)]


class Order(BaseModel):
    id: Text
    tenantId: Text
    userId: Text
    product: str
    paidCents: Nonnegative
    refundedCents: Nonnegative
    signedAt: str
    tracking: str
    deliveryStatus: str

    @field_validator("signedAt")
    @classmethod
    def date(cls, value):
        if datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("日期必须包含时区")
        return value


class Refund(BaseModel):
    id: Text
    requestKey: Text
    caseId: UUID
    version: Annotated[StrictInt, Field(gt=0)]
    orderId: Text
    amountCents: Nonnegative
    status: Literal["completed"]
    at: str
    _date = field_validator("at")(Order.date.__func__)


class Logistics(BaseModel):
    orderId: Text
    signedAt: str
    tracking: str
    status: str
    _date = field_validator("signedAt")(Order.date.__func__)


TOOL_OUTPUTS = {"list_orders": list[Order], "get_order": Order, "get_logistics": Logistics,
                "submit_refund": Refund, "get_refund": Refund | None}


def parse_tool_output(name, value):
    try:
        return TypeAdapter(TOOL_OUTPUTS[name]).dump_python(TypeAdapter(TOOL_OUTPUTS[name]).validate_python(value), mode="json")
    except (ValueError, KeyError, ValidationError) as error:
        raise ValueError(f"业务工具 {name} 返回的数据不符合约定：{error}") from error
