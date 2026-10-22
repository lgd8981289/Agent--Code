<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown, ChevronRight, CheckCircle2, CircleAlert } from "@lucide/vue";
import type { Trace } from "../../shared/types";
import { time } from "./api";
defineProps<{ items: Trace[] }>();
const open = ref("");
</script>
<template>
  <div class="trace-list">
    <p v-if="!items.length" class="empty-small">
      本次操作完成后，执行记录会显示在这里。
    </p>
    <div
      v-for="item in items"
      :key="item.id"
      class="trace-row"
      :class="{ child: item.parentId }"
    >
      <button class="trace-head" @click="open = open === item.id ? '' : item.id">
        <ChevronDown v-if="open === item.id" :size="14" /><ChevronRight
          v-else
          :size="14"
        />
        <CheckCircle2
          v-if="item.status === 'completed'"
          :size="15"
          class="green"
        /><CircleAlert v-else :size="15" class="red" />
        <span class="trace-name">{{ item.name }}</span
        ><small>{{ item.durationMs }} ms</small>
      </button>
      <div v-if="open === item.id" class="trace-body">
        <small
          >{{ item.kind }} · {{ time(item.at) }} ·
          {{ item.status === "completed" ? "调用正常返回" : "调用失败" }}</small
        ><label>输入</label>
        <pre>{{ JSON.stringify(item.input, null, 2) }}</pre>
        <label>输出</label>
        <pre>{{ JSON.stringify(item.output, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>
