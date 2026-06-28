"""根据任务特征选择业务代码、文本模型、推理模型或视觉路线。"""

from typing import Any


routes: dict[str, dict[str, Any]] = {
    "normalText": {
        "name": "normal_text",
        "layer": "表达层",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "thinking": {"type": "disabled"},
        "reason": "事实已经明确，只需要生成、改写或总结文本。",
    },
    "reasoningText": {
        "name": "reasoning_text",
        "layer": "分析层",
        "provider": "deepseek",
        "model": "deepseek-v4-pro",
        "thinking": {"type": "enabled"},
        "reasoning_effort": "high",
        "reason": "任务包含多条规则或多个条件，需要先分析再回答。",
    },
    "deterministicCode": {
        "name": "deterministic_code",
        "layer": "业务逻辑层",
        "provider": "application",
        "model": None,
        "reason": "命中了确定性业务规则，可以直接用代码判断。",
    },
    "visionPlan": {
        "name": "vision_plan",
        "layer": "感知层",
        "provider": "vision-provider",
        "model": "vision-capable-model",
        "reason": "关键证据在图片里，需要先进入多模态识别路线。",
    },
}


def route_task(profile: dict[str, Any]) -> dict[str, Any]:
    """按照图片、确定性规则、复杂推理、普通文本的优先级路由。"""
    if profile["hasImage"]:
        return routes["visionPlan"]
    if profile["deterministicRuleMatched"]:
        return routes["deterministicCode"]
    if profile["reasoningComplexity"] == "high":
        return routes["reasoningText"]
    return routes["normalText"]


def build_execution_plan(
    profile: dict[str, Any], route: dict[str, Any]
) -> list[str]:
    """为选中的路线生成可观察的执行步骤。"""
    del profile  # 当前计划只依赖路线，保留参数以对应 Node 版接口。

    if route["name"] == "vision_plan":
        return [
            "读取用户上传的图片证据",
            "调用多模态模型识别图片内容",
            "把识别结果转换成结构化字段",
            "再进入退款规则判断或人工复核",
        ]
    if route["name"] == "deterministic_code":
        return [
            "读取订单金额和人工审核阈值",
            "使用普通代码完成规则判断",
            "把判断结果交给普通模型生成用户回复",
        ]
    if route["name"] == "reasoning_text":
        return [
            "整理订单信息和退款规则",
            "开启 DeepSeek thinking 模式进行规则分析",
            "检查模型输出是否包含结论和依据",
        ]
    return [
        "整理已经验证过的业务事实",
        "关闭 thinking 模式，调用普通文本模型",
        "生成更自然的用户回复",
    ]
