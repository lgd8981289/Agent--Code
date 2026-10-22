<script setup lang="ts">
import { ShieldCheck, ChevronRight, CircleCheck, ClipboardList } from "@lucide/vue";
import type { Proposal, Policy, AfterSalesCase } from "../../shared/types";
import { statusLabels } from "../../shared/types";
import { money } from "./api";
defineProps<{
  proposal?: Proposal | null;
  activeCase?: AfterSalesCase;
  sourceList: Policy[];
  missing: string[];
  photoReady: boolean;
  validApplication: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{ materials: []; submit: []; case: [id: string] }>();
const amount = defineModel<number>("amount", { required: true });
const reason = defineModel<string>("reason", { required: true });
const accepted = defineModel<boolean>("accepted", { required: true });
const fault = defineModel<string>("fault", { required: true });
</script>
<template>
  <div class="context-heading">
    <ShieldCheck :size="20" />
    <h3>依据核对，再确认申请</h3>
  </div>
  <section v-if="sourceList.length" class="context-section">
    <h3>
      政策来源 <span>{{ sourceList.length }}</span>
    </h3>
    <details v-for="p in sourceList" :key="p.id" class="source">
      <summary>
        {{ p.title }}<small>v{{ p.version }}</small>
      </summary>
      <p>{{ p.content }}</p>
      <small>{{ p.id }}</small>
    </details>
  </section>
  <template v-if="proposal"
    ><div class="order-facts">
      <div class="order-summary-head">
        <img
          v-if="proposal.order.id === 'A1024'"
          src="/coffee-machine.png"
          alt="星河 C7 咖啡机"
        />
        <div>
          <small>已核实订单</small
          ><strong>{{ proposal.order.id }} · {{ proposal.order.product }}</strong>
        </div>
        <span
          class="status compact"
          :class="
            activeCase?.status || (proposal.eligible ? 'ready' : 'needs_materials')
          "
          >{{
            activeCase
              ? statusLabels[activeCase.status]
              : proposal.eligible
                ? "可提交"
                : "需核对"
          }}</span
        >
      </div>
      <div class="order-fact-grid">
        <div>
          <span>实付金额</span><b>{{ money(proposal.order.paidCents) }}</b>
        </div>
        <div>
          <span>可退金额</span><b>{{ money(proposal.amountCents) }}</b>
        </div>
        <div>
          <span>物流状态</span><b>{{ proposal.order.deliveryStatus }}</b>
        </div>
      </div>
    </div>

    <div v-if="missing.length" class="missing-list">
      <small>还需要补充</small>
      <p v-for="item in missing" :key="item">{{ item }}</p>
      <button v-if="!photoReady" class="text-button" @click="emit('materials')">
        前往材料核对 <ChevronRight :size="14" />
      </button>
    </div>
    <div v-if="!proposal.eligible" class="notice warning">
      当前订单或政策条件不满足本演示的申请要求，请人工核对。
    </div>
    <template v-if="!activeCase"
      ><section class="context-section">
        <h3>申请内容</h3>
        <label
          >申请金额（元）<input
            v-model.number="amount"
            type="number"
            step="0.01"
            min="0.01"
            :max="proposal.amountCents / 100" /></label
        ><label>问题说明<textarea v-model="reason" rows="3" maxlength="1500" /></label>
        <details class="demo-options">
          <summary>故障演示设置</summary>
          <select v-model="fault">
            <option value="none">正常执行</option>
            <option value="timeout_after_commit">已受理，但响应丢失</option>
            <option value="before_submit">提交前服务暂不可用</option>
          </select>
        </details>
        <label class="checkbox-label"
          ><input
            v-model="accepted"
            type="checkbox"
          />我已核对金额、材料和申请内容</label
        ><button
          class="primary full"
          :disabled="
            busy ||
            !accepted ||
            !validApplication ||
            !photoReady ||
            !proposal.eligible ||
            missing.length > 0
          "
          @click="emit('submit')"
        >
          <CircleCheck :size="17" />确认申请，提交企业审核
        </button>
      </section></template
    ><button v-else class="primary full" @click="emit('case', activeCase.id)">
      <ClipboardList :size="17" />查看申请 ·
      {{ statusLabels[activeCase.status] }}
    </button></template
  >
  <div v-else class="empty-small">
    发送订单与问题后，在这里查看核对结果、政策来源和待补充材料。
  </div>
</template>
