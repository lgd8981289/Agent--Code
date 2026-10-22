import { nextTick, onScopeDispose, ref } from "vue";
import { ApiError } from "../api";

/** 每次朗读拥有独立请求和 Blob URL；停止后丢弃迟到响应。 */
export function useSpeechPlayback(
  enabled: () => boolean,
  onError: (error: unknown) => void,
) {
  const speechPlayer = ref<HTMLAudioElement | null>(null),
    audioUrl = ref(""),
    speechStatus = ref("");
  const playingId = ref(""),
    speechBusy = ref(false);
  let playbackAbort: AbortController | null = null,
    playbackGeneration = 0;
  let audio: HTMLAudioElement | null = null;
  function stopPlayback() {
    playbackGeneration++;
    playbackAbort?.abort();
    playbackAbort = null;
    if (playingId.value) speechBusy.value = false;
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    audio = null;
    if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
    audioUrl.value = "";
    speechStatus.value = "";
    playingId.value = "";
  }
  async function speak(target: { id: string; content: string }) {
    if (!enabled()) return;
    if (playingId.value === target.id) {
      stopPlayback();
      return;
    }
    // 换到另一条时先停掉正在播的，避免两段音频叠在一起。
    stopPlayback();
    const generation = playbackGeneration;
    speechBusy.value = true;
    playingId.value = target.id;
    speechStatus.value = "正在生成语音…";
    playbackAbort = new AbortController();
    const abort = playbackAbort;
    try {
      const response = await fetch("/api/voice/speak", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: target.content.slice(0, 1500) }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new ApiError(result.message || "语音合成失败，请重试", response.status);
      }
      const blob = await response.blob();
      if (generation !== playbackGeneration) return;
      if (!blob.size || !blob.type.startsWith("audio/"))
        throw new Error("没有收到有效音频，请重新朗读");
      audioUrl.value = URL.createObjectURL(blob);
      speechStatus.value = "语音已就绪";
      await nextTick();
      const player = speechPlayer.value;
      if (generation !== playbackGeneration || !player) return;
      audio = player;
      player.scrollIntoView({ block: "nearest" });
      try {
        await player.play();
      } catch (e) {
        if (generation !== playbackGeneration) return;
        if ((e as Error).name === "NotAllowedError")
          speechStatus.value = "语音已就绪，请点击播放器的播放按钮";
        else throw new Error("音频无法播放，请重新朗读", { cause: e });
      }
    } catch (e) {
      if (generation === playbackGeneration) {
        stopPlayback();
        if ((e as Error).name !== "AbortError") onError(e);
      }
    } finally {
      if (generation === playbackGeneration) {
        speechBusy.value = false;
        playbackAbort = null;
      }
    }
  }
  function playbackError() {
    if (!playingId.value || !audioUrl.value) return;
    stopPlayback();
    onError(new Error("音频加载或解码失败，请重新朗读"));
  }

  onScopeDispose(stopPlayback);
  return {
    speechPlayer,
    audioUrl,
    speechStatus,
    playingId,
    speechBusy,
    speak,
    stopPlayback,
    playbackError,
  };
}
