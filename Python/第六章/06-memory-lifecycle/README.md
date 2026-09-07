# Memory Lifecycle（Python 版）

本节演示长期记忆进入 Store 之后的生命周期管理：

- 去重：同一偏好的别名和重复处理不会创建新条目。
- 冲突：长期偏好发生变化时，先等待用户确认。
- 过期：过期记忆不再对外返回，但底层 Store 可以暂时保留物理记录。
- 删除：用户删除后，清除正文，并写入阻断标记，防止旧聊天记录重新写回。
- 隔离：不同用户、不同租户的记忆和删除标记互不影响。

## 文件说明

- `scenarios.py`：固定候选数据，模拟上一节已经完成提取和审核后的输入。
- `memory_manager.py`：长期记忆生命周期规则，是本节核心文件。
- `memory_lifecycle.py`：演示入口，顺序展示新增、去重、冲突确认、过期、删除和隔离。
- `tests/test_memory_manager.py`：离线测试，使用真实 `InMemoryStore`，不调用模型和数据库。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 离线运行

```bash
python memory_lifecycle.py
python -m unittest discover -s tests -v
```

本节不需要 API Key、环境变量文件或数据库。案例使用真实 `InMemoryStore`，进程结束后数据消失。

关键预期结果：第一次写入 `preferred_runtime=Node.js`；重复的 `nodejs` 会被识别成重复；“这一次用 Python”不会覆盖长期偏好；确认后长期偏好更新为 `Python`；删除后旧候选再次出现也会被阻断。

## 注意点

`expiresAt` 是业务有效期，不是 Store 的自动清理配置。必须通过 `get_active_memory()` 或 `recall_memories()` 读取，才能过滤过期数据。

删除时会先写入 `lifecycle-blocks`，再删除正常记忆正文。这样即使物理删除失败，正常读写也会先被阻断，后续可以重试删除。

本案例按单用户串行处理。生产多进程并发时，读取、版本校验和写入需要数据库事务、CAS（Compare-And-Swap）或其他原子版本检查机制。
