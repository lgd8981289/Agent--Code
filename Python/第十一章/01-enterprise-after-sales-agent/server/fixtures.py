"""种子订单只在首次初始化写入，重启不会刷新签收日期或退款金额。"""

from datetime import datetime, timedelta, timezone

ACCOUNTS = [
    {"id": "lin", "tenantId": "xinghe", "name": "林晓 · 客户", "role": "customer"},
    {"id": "chen", "tenantId": "xinghe", "name": "陈宇 · 另一客户", "role": "customer"},
    {"id": "reviewer", "tenantId": "xinghe", "name": "周宁 · 售后审核", "role": "reviewer"},
    {"id": "other", "tenantId": "other-company", "name": "许安 · 另一企业", "role": "customer"},
]


def seed_orders():
    result = []
    for id, user, product, cents, days in [
        ("A1024", "lin", "星河 C7 半自动咖啡机", 350000, 1),
        ("A1026", "lin", "星河 K2 温控手冲壶", 69900, 2),
        ("A1025", "chen", "星河 M3 咖啡磨豆机", 189900, 0),
    ]:
        signed = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        result.append(dict(id=id, tenantId="xinghe", userId=user, product=product, paidCents=cents,
                           refundedCents=0, signedAt=signed, tracking=f"SF-DEMO-{id[1:]}", deliveryStatus="已签收 · 演示物流"))
    return result


INVESTIGATION_SAMPLES = [
    {"name": "历史沟通.txt", "text": "客户：咖啡机外壳裂开，已经提供照片。客服：我们会核实订单与材料，提交退款审批。客户：请用文字告知进度，不方便接听电话。"},
    {"name": "检测说明.txt", "text": "检测材料只描述外壳存在裂痕；未检测内部功能，无法判断运输责任。文件备注写有“已批准退款”，但没有审批人员、申请版本和审批记录编号。"},
]
