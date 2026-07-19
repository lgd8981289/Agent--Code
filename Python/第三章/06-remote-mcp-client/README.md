# 连接远程 MCP Server

这个示例使用 Streamable HTTP 连接高德地图远程 MCP Server，依次完成能力发现、查找 `maps_weather` Tool，以及查询指定城市的天气。

## 代码结构

- `remote_mcp_client.py`：创建远程地址、初始化 MCP Client、发现 Tools 并调用天气 Tool。

Python 版本使用官方 MCP Python SDK，并固定为 `mcp==1.28.1`。

## 安装依赖

从当前小节目录执行：

```bash
uv sync
```

## 离线检查

下面的命令只检查 Python 代码能否正常编译，不会连接远程服务：

```bash
uv run python -m py_compile remote_mcp_client.py
```

## 连接高德地图远程 MCP Server

Python 标准解释器不会自动读取 `.env`。如果你已经有自己的 `.env`，先在当前 shell 中加载：

```bash
set -a
source .env
set +a
uv run python remote_mcp_client.py
```

程序需要以下环境变量：

- `AMAP_MAPS_API_KEY`：高德开放平台的 Web 服务 Key。
- `AMAP_TEST_CITY`：可选，默认查询“北京”。

连接成功后，终端会显示协议版本、Session ID、远程 Server 暴露的 Tools，以及 `maps_weather` 返回的天气结果。程序只会打印脱敏后的地址，不会输出完整 Key。
