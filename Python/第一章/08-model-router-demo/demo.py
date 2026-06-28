"""运行四种任务，观察任务分析、模型路由与执行计划。"""

from typing import Any

from deepseek_client import call_deepseek
from model_router import build_execution_plan, route_task
from task_profiler import profile_task


tasks: list[dict[str, Any]] = [
    {
        "id": "rewrite-reply",
        "userText": (
            "把审核结果改写成一句客服回复："
            "订单 A1024 退款金额超过 2000 元，需要人工审核。"
        ),
        "expectedOutput": "text",
    },
    {
        "id": "amount-check",
        "userText": (
            "订单 A1024 的退款金额是 3000 元，"
            "是否超过人工审核阈值 2000 元？"
        ),
        "order": {
            "id": "A1024",
            "refundAmount": 3000,
            "manualReviewThreshold": 2000,
        },
        "expectedOutput": "decision",
    },
    {
        "id": "policy-analysis",
        "userText": """
用户签收 3 天，商品不是生鲜，退款金额 3000 元。
规则 A：普通商品签收 7 天内可退款。
规则 B：生鲜不支持无理由退款。
规则 C：超过 2000 元需要人工审核。
规则 D：如果订单存在风控标记，必须进入人工复核。

请判断当前订单应该进入哪个流程，并说明依据。
""",
        "expectedOutput": "reasoned_decision",
    },
    {
        "id": "photo-check",
        "userText": "这张图片里的咖啡机外壳是不是破损了？我要申请退款。",
        "attachments": [
            {"type": "image", "name": "coffee-machine.jpg"}
        ],
        "expectedOutput": "vision_decision",
    },
]


def run_deterministic_rule(task: dict[str, Any]) -> dict[str, Any]:
    """用普通代码执行确定性金额阈值判断。"""
    order = task["order"]
    refund_amount = order["refundAmount"]
    threshold = order["manualReviewThreshold"]
    return {
        "needManualReview": refund_amount > threshold,
        "reason": f"退款金额 {refund_amount} 元，人工审核阈值 {threshold} 元。",
    }


def build_messages(
    task: dict[str, Any], route: dict[str, Any]
) -> list[dict[str, str]]:
    """根据普通表达或复杂分析路线组装 messages。"""
    if route["name"] == "normal_text":
        system_content = (
            "你是退款客服助手。请把业务结果改写成简洁、自然的用户回复。"
        )
    else:
        system_content = (
            "你是退款审核助手。请基于用户给出的订单信息和规则，"
            "给出结论与依据。"
        )
    return [
        {"role": "system", "content": system_content},
        {"role": "user", "content": task["userText"]},
    ]


def run_task(task: dict[str, Any]) -> dict[str, Any]:
    """分析并执行单个任务。"""
    profile = profile_task(task)
    route = route_task(profile)
    plan = build_execution_plan(profile, route)

    print("\n==============================")
    print("任务：", task["id"])
    print("路线：", route["name"])
    print("位置：", route["layer"])
    print("原因：", route["reason"])
    print("执行计划：")
    for index, step in enumerate(plan, start=1):
        print(f"{index}. {step}")

    if route["name"] == "deterministic_code":
        result = run_deterministic_rule(task)
        print("代码判断结果：")
        print(result)
        return {"profile": profile, "route": route, "plan": plan, "result": result}

    if route["name"] == "vision_plan":
        explanation = (
            "当前 DeepSeek 文本接口不直接处理图片输入，"
            "这里只生成多模态执行计划。"
        )
        print("多模态路线说明：")
        print(explanation)
        return {
            "profile": profile,
            "route": route,
            "plan": plan,
            "result": {"explanation": explanation},
        }

    result = call_deepseek(
        route=route,
        messages=build_messages(task, route),
    )
    if result["skipped"]:
        print(result["reason"])
        print("DeepSeek 请求体：")
        print(result["requestBody"])
    else:
        print("DeepSeek 返回：")
        print(result["content"])
        print("调用统计：")
        print({"latencyMs": result["latencyMs"], "usage": result["usage"]})

    return {"profile": profile, "route": route, "plan": plan, "result": result}


def main() -> list[dict[str, Any]]:
    """依次执行全部四种测试任务。"""
    return [run_task(task) for task in tasks]


if __name__ == "__main__":
    main()
