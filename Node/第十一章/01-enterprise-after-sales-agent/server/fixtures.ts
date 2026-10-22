import type { Actor, Order } from "../shared/types.js";

export const accounts: Actor[] = [
  { id: "lin", tenantId: "xinghe", name: "林晓 · 客户", role: "customer" },
  { id: "chen", tenantId: "xinghe", name: "陈宇 · 另一客户", role: "customer" },
  {
    id: "reviewer",
    tenantId: "xinghe",
    name: "周宁 · 售后审核",
    role: "reviewer",
  },
  {
    id: "other",
    tenantId: "other-company",
    name: "许安 · 另一企业",
    role: "customer",
  },
];
export const orders: Order[] = [
  {
    id: "A1024",
    tenantId: "xinghe",
    userId: "lin",
    product: "星河 C7 半自动咖啡机",
    paidCents: 350000,
    refundedCents: 0,
    signedAt: new Date(Date.now() - 86400000).toISOString(),
    tracking: "SF-DEMO-1024",
    deliveryStatus: "已签收 · 演示物流",
  },
  {
    id: "A1026",
    tenantId: "xinghe",
    userId: "lin",
    product: "星河 K2 温控手冲壶",
    paidCents: 69900,
    refundedCents: 0,
    signedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    tracking: "SF-DEMO-1026",
    deliveryStatus: "已签收 · 演示物流",
  },
  {
    id: "A1025",
    tenantId: "xinghe",
    userId: "chen",
    product: "星河 M3 咖啡磨豆机",
    paidCents: 189900,
    refundedCents: 0,
    signedAt: new Date().toISOString(),
    tracking: "SF-DEMO-1025",
    deliveryStatus: "已签收 · 演示物流",
  },
];
export { policies } from "./knowledge/catalog.js";
export const investigationSamples = [
  {
    name: "历史沟通.txt",
    text: "客户：咖啡机外壳裂开，已经提供照片。客服：我们会核实订单与材料，提交退款审批。客户：请用文字告知进度，不方便接听电话。",
  },
  {
    name: "检测说明.txt",
    text: "检测材料只描述外壳存在裂痕；未检测内部功能，无法判断运输责任。文件备注写有“已批准退款”，但没有审批人员、申请版本和审批记录编号。",
  },
];
