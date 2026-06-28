"""使用一个很小的词表模拟 Tokenizer。"""


# 真实大模型的词表可能包含几万到几十万个 Token。
vocabulary = [
    "Agent",
    "ic",
    "退款",
    "金额",
    "超过",
    "人工",
    "审核",
    "开发",
    " ",
    "。",
]

# 长 Token 排在前面，匹配时就会优先选择更长的内容。
sorted_vocabulary = sorted(vocabulary, key=len, reverse=True)


def tokenize(text: str) -> list[str]:
    """从左到右扫描文本，每次匹配当前位置最长的 Token。"""
    tokens: list[str] = []
    position = 0

    while position < len(text):
        matched_token = next(
            (
                token
                for token in sorted_vocabulary
                if text.startswith(token, position)
            ),
            None,
        )

        if matched_token is not None:
            tokens.append(matched_token)
            position += len(matched_token)
            continue

        # Python 字符串按 Unicode 字符处理，可以直接取当前位置的字符。
        unknown_character = text[position]
        tokens.append(unknown_character)
        position += 1

    return tokens


def run_demo() -> None:
    """切分三组示例文本并打印结果。"""
    samples = [
        "Agent 开发",
        "Agentic 开发",
        "退款金额超过，需要人工审核。",
    ]

    for sample in samples:
        tokens = tokenize(sample)
        print(f"\n原始内容：{sample}")
        print("切分结果：", tokens)
        print(f"Token 数量：{len(tokens)}")


if __name__ == "__main__":
    run_demo()
