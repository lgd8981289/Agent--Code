"""本地工具定义和执行器。"""

from __future__ import annotations

import json
import re
from typing import Any, Callable


# 使用内存中的 dict 模拟真实订单系统。
#
# 实际项目中，这里通常会替换成：
# - 数据库查询
# - 订单服务接口
# - ERP 或第三方业务系统
#
# 当前案例只关注 Tool Calling 流程，因此不引入数据库。
orders = {
    "A1024": {
        "orderId": "A1024",
        "status": "delivered",
        "productName": "咖啡机",
        "productType": "normal",
        "daysSinceDelivered": 3,
        "refundAmount": 3000,
    },
    "A2048": {
        "orderId": "A2048",
        "status": "delivered",
        "productName": "新鲜草莓",
        "productType": "fresh",
        "daysSinceDelivered": 1,
        "refundAmount": 99,
    },
}


def _get_order_parameters() -> dict[str, Any]:
    """get_order 工具的 JSON Schema 参数结构。"""

    return {
        "type": "object",
        "properties": {
            "orderId": {
                "type": "string",
                "pattern": "^A\\d{4}$",
                "description": "订单号，例如 A1024",
            }
        },
        "required": ["orderId"],
        "additionalProperties": False,
    }


def _refund_check_parameters() -> dict[str, Any]:
    """check_refund_eligibility 工具的 JSON Schema 参数结构。"""

    return {
        "type": "object",
        "properties": {
            "orderId": {
                "type": "string",
                "pattern": "^A\\d{4}$",
                "description": "订单号",
            },
            "orderStatus": {
                "type": "string",
                "enum": ["pending", "delivered", "cancelled"],
                "description": "订单当前状态",
            },
            "productType": {
                "type": "string",
                "enum": ["normal", "fresh"],
                "description": "商品类型，normal 表示普通商品，fresh 表示生鲜",
            },
            "daysSinceDelivered": {
                "type": "integer",
                "minimum": 0,
                "description": "签收后经过的天数",
            },
            "refundAmount": {
                "type": "number",
                "minimum": 0,
                "description": "本次退款金额，单位为元",
            },
        },
        "required": [
            "orderId",
            "orderStatus",
            "productType",
            "daysSinceDelivered",
            "refundAmount",
        ],
        "additionalProperties": False,
    }


# 提供给大模型的工具说明。
#
# 模型只能看到：
# - 工具名称
# - 工具描述
# - 参数结构
#
# 模型看不到 tool_registry 中的真实执行函数，也不能直接访问订单数据。
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_order",
            "description": (
                "根据订单号查询订单实时信息。判断退款条件之前必须先调用这个工具，"
                "不能猜测订单状态。"
            ),
            "parameters": _get_order_parameters(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_refund_eligibility",
            "description": (
                "根据 get_order 返回的真实订单字段判断是否允许退款，以及是否需要人工审核。"
            ),
            "parameters": _refund_check_parameters(),
        },
    },
]


def _create_error(
    code: str, message: str, issues: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """创建统一的工具错误返回结构。"""

    error: dict[str, Any] = {
        "code": code,
        "message": message,
    }
    if issues is not None:
        error["issues"] = issues
    return {"ok": False, "error": error}


def _validate_order_id(value: Any, field: str = "orderId") -> list[dict[str, Any]]:
    """校验订单号格式。"""

    issues: list[dict[str, Any]] = []
    if not isinstance(value, str):
        issues.append(
            {
                "path": [field],
                "message": "订单号必须是字符串。",
            }
        )
    elif not re.fullmatch(r"A\d{4}", value):
        issues.append(
            {
                "path": [field],
                "message": "订单号格式必须类似 A1024",
            }
        )
    return issues


def _validate_get_order_arguments(arguments: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """校验 get_order 工具参数。"""

    issues = _validate_order_id(arguments.get("orderId"))
    if issues:
        return None, issues
    return {"orderId": arguments["orderId"]}, []


def _validate_refund_arguments(arguments: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """校验 check_refund_eligibility 工具参数。"""

    issues = _validate_order_id(arguments.get("orderId"))

    order_status = arguments.get("orderStatus")
    if order_status not in {"pending", "delivered", "cancelled"}:
        issues.append(
            {
                "path": ["orderStatus"],
                "message": "orderStatus 必须是 pending、delivered 或 cancelled。",
            }
        )

    product_type = arguments.get("productType")
    if product_type not in {"normal", "fresh"}:
        issues.append(
            {
                "path": ["productType"],
                "message": "productType 必须是 normal 或 fresh。",
            }
        )

    days_since_delivered = arguments.get("daysSinceDelivered")
    if (
        not isinstance(days_since_delivered, int)
        or isinstance(days_since_delivered, bool)
        or days_since_delivered < 0
    ):
        issues.append(
            {
                "path": ["daysSinceDelivered"],
                "message": "daysSinceDelivered 必须是非负整数。",
            }
        )

    refund_amount = arguments.get("refundAmount")
    if (
        not isinstance(refund_amount, (int, float))
        or isinstance(refund_amount, bool)
        or refund_amount < 0
    ):
        issues.append(
            {
                "path": ["refundAmount"],
                "message": "refundAmount 必须是非负数字。",
            }
        )

    if issues:
        return None, issues

    return (
        {
            "orderId": arguments["orderId"],
            "orderStatus": order_status,
            "productType": product_type,
            "daysSinceDelivered": days_since_delivered,
            "refundAmount": refund_amount,
        },
        [],
    )


def _get_order(arguments: dict[str, Any]) -> dict[str, Any]:
    """查询订单真实信息。"""

    order_id = arguments["orderId"]
    order = orders.get(order_id)

    # 订单不存在时，返回结构化错误，方便模型理解失败原因。
    if not order:
        return {
            "ok": False,
            "error": {
                "code": "ORDER_NOT_FOUND",
                "message": f"没有找到订单 {order_id}",
            },
        }

    return {
        "ok": True,
        "order": order,
    }


def _check_refund_eligibility(arguments: dict[str, Any]) -> dict[str, Any]:
    """根据真实订单信息判断退款资格。"""

    order_id = arguments["orderId"]
    order = orders.get(order_id)

    if not order:
        return _create_error("ORDER_NOT_FOUND", f"没有找到订单 {order_id}")

    # Python 的显式参数校验只能校验参数类型和格式，
    # 不能判断模型传入的数据是否与订单系统中的真实数据一致。
    #
    # 因此这里还要进行一次业务数据核对，
    # 防止模型修改、猜测或错误传递订单字段。
    mismatched_fields = [
        field
        for field, received, actual in [
            ("orderStatus", arguments["orderStatus"], order["status"]),
            ("productType", arguments["productType"], order["productType"]),
            (
                "daysSinceDelivered",
                arguments["daysSinceDelivered"],
                order["daysSinceDelivered"],
            ),
            ("refundAmount", arguments["refundAmount"], order["refundAmount"]),
        ]
        if received != actual
    ]

    if mismatched_fields:
        return {
            "ok": False,
            "error": {
                "code": "ORDER_DATA_MISMATCH",
                "message": "工具参数与订单系统中的真实数据不一致。",
                "fields": mismatched_fields,
            },
        }

    # 退款规则一：
    # 只有已经签收的订单，才能进入签收后的退款判断流程。
    if order["status"] != "delivered":
        return {
            "ok": True,
            "orderId": order_id,
            "refundable": False,
            "reason": "订单尚未签收，不能进入签收后的退款流程。",
        }

    # 退款规则二：
    # 生鲜商品不支持无理由退款。
    if order["productType"] == "fresh":
        return {
            "ok": True,
            "orderId": order_id,
            "refundable": False,
            "reason": "生鲜商品不支持无理由退款。",
        }

    # 退款规则三：
    # 普通商品只能在签收后 7 天内申请退款。
    if order["daysSinceDelivered"] > 7:
        return {
            "ok": True,
            "orderId": order_id,
            "refundable": False,
            "reason": "普通商品已经超过签收后 7 天的退款期限。",
        }

    # 退款规则四：
    # 退款金额超过 2000 元时，需要进入人工审核。
    need_manual_review = order["refundAmount"] > 2000

    return {
        "ok": True,
        "orderId": order_id,

        # 前面的退款条件均已通过。
        "refundable": True,

        # 是否需要人工审核。
        "needManualReview": need_manual_review,

        # 根据金额决定进入自动审核还是人工审核。
        "reviewType": "manual" if need_manual_review else "automatic",
        "reason": (
            "满足退款条件，但退款金额超过 2000 元，需要人工审核。"
            if need_manual_review
            else "满足退款条件，可以进入自动退款流程。"
        ),
    }


Validator = Callable[[dict[str, Any]], tuple[dict[str, Any] | None, list[dict[str, Any]]]]
Executor = Callable[[dict[str, Any]], dict[str, Any]]


# 应用程序内部的工具注册表。
#
# 它负责将模型返回的工具名称映射到：
# - validator：参数校验函数
# - execute：真实工具执行函数
#
# 这部分不会发送给大模型。
tool_registry: dict[str, dict[str, Validator | Executor]] = {
    "get_order": {
        "validator": _validate_get_order_arguments,
        "execute": _get_order,
    },
    "check_refund_eligibility": {
        "validator": _validate_refund_arguments,
        "execute": _check_refund_eligibility,
    },
}


def execute_tool_call(tool_call: dict[str, Any]) -> dict[str, Any]:
    """执行模型返回的单次工具调用。

    完整流程：

    1. 根据工具名称查找注册的工具
    2. 解析模型生成的 JSON 参数
    3. 使用对应校验函数校验参数
    4. 调用应用程序中的真实工具函数
    5. 捕获异常并返回结构化错误
    """

    function = tool_call.get("function") or {}
    tool_name = function.get("name")
    registered_tool = tool_registry.get(tool_name)

    if not registered_tool:
        return _create_error("TOOL_NOT_FOUND", "应用程序没有注册这个工具。")

    # 模型返回的 function.arguments 通常是 JSON 字符串，
    # 需要先解析成 Python dict。
    try:
        raw_arguments = json.loads(function.get("arguments") or "")
    except json.JSONDecodeError:
        return _create_error("INVALID_JSON_ARGUMENTS", "工具参数不是合法 JSON。")

    if not isinstance(raw_arguments, dict):
        return _create_error("INVALID_TOOL_ARGUMENTS", "工具参数必须是 JSON 对象。")

    validator = registered_tool["validator"]
    assert callable(validator)
    parsed_arguments, issues = validator(raw_arguments)

    if parsed_arguments is None:
        return _create_error(
            "INVALID_TOOL_ARGUMENTS",
            "工具参数没有通过参数校验。",
            issues,
        )

    execute = registered_tool["execute"]
    assert callable(execute)

    # 参数校验通过后，调用应用程序中的真实工具函数。
    try:
        return execute(parsed_arguments)
    except Exception as error:
        # 捕获真实工具执行过程中出现的未知异常。
        return _create_error("TOOL_EXECUTION_FAILED", str(error))

