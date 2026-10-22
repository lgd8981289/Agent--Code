import "dotenv/config";
const port = process.env.PORT || 4320;
const deadline = Date.now() + 60000;
console.log(`等待售后 API：http://127.0.0.1:${port}/api/health`);
while (Date.now() < deadline) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    if ((await r.json()).service === "aftersales-agent") process.exit(0);
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.error(
  "API 尚未启动。请检查 PostgreSQL 是否已启动、端口是否被其他项目占用，以及服务端启动日志。",
);
process.exit(1);
