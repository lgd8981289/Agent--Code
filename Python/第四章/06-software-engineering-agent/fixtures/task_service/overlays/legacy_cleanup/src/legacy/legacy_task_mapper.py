"""已经被 TaskService 替代的旧映射器。

当前项目没有任何模块继续引用这个文件。
"""


def map_legacy_task(input_value: dict[str, str]):
    return {"title": input_value["task_name"]}
