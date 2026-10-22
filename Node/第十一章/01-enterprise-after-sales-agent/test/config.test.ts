import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dashscope,
  inspectConfig,
  multimodalReady,
  visionModel,
} from "../server/config.js";

const PUBLIC_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

test("视觉模型尊重显式配置，未配置时才使用默认值", () => {
  assert.equal(visionModel({}), "qwen3-vl-plus");
  assert.equal(visionModel({ VISION_MODEL: "  " }), "qwen3-vl-plus");
  assert.equal(visionModel({ VISION_MODEL: " qwen3-vl-flash " }), "qwen3-vl-flash");
  assert.equal(visionModel({ VISION_MODEL: "custom-vision" }), "custom-vision");
});

test("百炼只配一个地址，默认为公共兼容接口", () => {
  // 学生只填 Key 是最常见的情况，此时必须能直接工作，不需要再填地址。
  assert.equal(dashscope({ DASHSCOPE_API_KEY: "k" }).baseUrl, PUBLIC_BASE);
  // 语音合成与实时识别都从这个地址推导，换业务空间时只改这一处。
  assert.equal(
    dashscope({
      DASHSCOPE_API_KEY: "k",
      DASHSCOPE_BASE_URL: "https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    }).baseUrl,
    "https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  );
});

test("没填 Key 时多模态关闭，不因为地址有默认值就误报可用", () => {
  assert.equal(multimodalReady({}), false);
  assert.equal(multimodalReady({ DASHSCOPE_BASE_URL: PUBLIC_BASE }), false);
  assert.equal(multimodalReady({ DASHSCOPE_API_KEY: "k" }), true);
});

test("配置检查不为正常配置制造告警", () => {
  const report = inspectConfig({
    DEEPSEEK_API_KEY: "k",
    DASHSCOPE_API_KEY: "k",
  });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test("地址少了兼容路径或域名不对时要提示", () => {
  const missingPath = inspectConfig({
    DASHSCOPE_API_KEY: "k",
    DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com",
  });
  assert.match(missingPath.warnings.join("；"), /compatible-mode\/v1/);

  const wrongHost = inspectConfig({
    DASHSCOPE_API_KEY: "k",
    DASHSCOPE_BASE_URL: "https://help.aliyun.com/compatible-mode/v1",
  });
  assert.match(wrongHost.warnings.join("；"), /不是百炼的兼容接口域名/);
});
