<script setup lang="ts">
import { nextTick, ref, useId, watch } from "vue";
import { X, LoaderCircle } from "@lucide/vue";
const props = defineProps<{
  open: boolean;
  title: string;
  confirmLabel: string;
  disabled?: boolean;
  danger?: boolean;
  busy?: boolean;
  error?: string;
}>();
const emit = defineEmits<{ cancel: []; confirm: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = useId();
watch(
  () => props.open,
  async (value) => {
    await nextTick();
    if (value && !dialog.value?.open) dialog.value?.showModal();
    if (!value && dialog.value?.open) dialog.value?.close();
  },
  { immediate: true },
);
</script>

<template>
  <dialog
    ref="dialog"
    class="confirm-dialog"
    :aria-labelledby="titleId"
    :aria-busy="busy"
    @cancel.prevent="!busy && emit('cancel')"
  >
    <header>
      <h2 :id="titleId">{{ title }}</h2>
      <button
        class="icon-button"
        title="关闭确认"
        :disabled="busy"
        @click="emit('cancel')"
      >
        <X :size="18" />
      </button>
    </header>
    <div class="dialog-content"><slot /></div>
    <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    <footer>
      <button class="secondary" :disabled="busy" autofocus @click="emit('cancel')">
        取消
      </button>
      <button
        :class="danger ? 'primary danger' : 'primary'"
        :disabled="disabled || busy"
        @click="emit('confirm')"
      >
        <LoaderCircle v-if="busy" class="spin" :size="16" />{{
          busy ? "正在处理…" : confirmLabel
        }}
      </button>
    </footer>
  </dialog>
</template>
