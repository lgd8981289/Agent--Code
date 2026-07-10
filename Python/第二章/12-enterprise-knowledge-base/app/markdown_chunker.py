"""Markdown 分块逻辑。"""

from __future__ import annotations

import re

from app.models import TextChunk


def normalize_markdown(markdown: str) -> str:
    """统一不同操作系统的换行符，保证 checksum 和分块结果稳定。"""

    return markdown.replace("\r\n", "\n").replace("\r", "\n").strip()


def _node_to_text(block: list[str], *, is_code: bool) -> str:
    """把 Markdown 块转换成适合检索的纯文本。"""

    text = "\n".join(block) if is_code else " ".join(block)
    return text.strip() if is_code else re.sub(r"\s+", " ", text).strip()


def _parse_sections(markdown: str) -> list[dict[str, object]]:
    """把 Markdown 按标题层级整理成多个文本段落区块。

    这里用轻量解析覆盖课程样例所需的标题、段落和代码块。复杂 Markdown 生产系统
    可以替换为 markdown-it-py 等 AST 解析器。
    """

    sections: list[dict[str, object]] = []
    heading_path: list[str] = []
    current: dict[str, object] = {"heading": "", "paragraphs": []}
    paragraph: list[str] = []
    code_block: list[str] = []
    in_code = False

    def flush_section() -> None:
        if current["paragraphs"]:
            sections.append(current.copy())

    def flush_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            text = _node_to_text(paragraph, is_code=False)
            if text:
                paragraphs = current["paragraphs"]
                assert isinstance(paragraphs, list)
                paragraphs.append(text)
            paragraph = []

    def flush_code() -> None:
        nonlocal code_block
        text = _node_to_text(code_block, is_code=True)
        if text:
            paragraphs = current["paragraphs"]
            assert isinstance(paragraphs, list)
            paragraphs.append(text)
        code_block = []

    for line in markdown.split("\n"):
        if line.startswith("```"):
            if in_code:
                flush_code()
                in_code = False
            else:
                flush_paragraph()
                in_code = True
            continue

        if in_code:
            code_block.append(line)
            continue

        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            flush_paragraph()
            flush_section()
            depth = len(match.group(1))
            heading_path = heading_path[: depth - 1]
            while len(heading_path) < depth:
                heading_path.append("")
            heading_path[depth - 1] = match.group(2).strip()
            current = {
                "heading": " / ".join(item for item in heading_path if item),
                "paragraphs": [],
            }
            continue

        if line.strip():
            paragraph.append(line.strip())
        else:
            flush_paragraph()

    if in_code:
        flush_code()
    flush_paragraph()
    flush_section()
    return sections


def _split_long_text(text: str, max_length: int, overlap: int) -> list[str]:
    """切分超过 Chunk 上限的长文本，并保留少量重叠内容。"""

    parts: list[str] = []
    step = max(1, max_length - overlap)
    for start in range(0, len(text), step):
        parts.append(text[start : start + max_length])
        if start + max_length >= len(text):
            break
    return parts


def chunk_markdown(
    markdown: str, max_length: int = 700, overlap: int = 80
) -> list[TextChunk]:
    """按标题和段落生成最终 Chunk。

    Args:
        markdown: 原始 Markdown 文本。
        max_length: 单个 Chunk 的目标字符上限。
        overlap: 长文本切分时保留的重叠字符数。
    """

    normalized = normalize_markdown(markdown)
    if not normalized:
        return []

    chunks: list[str] = []
    for section in _parse_sections(normalized):
        # 标题会重复写入当前章节的每个 Chunk，避免正文离开标题后失去语义。
        heading = str(section["heading"])
        paragraphs = section["paragraphs"]
        assert isinstance(paragraphs, list)
        prefix = f"{heading}\n\n" if heading else ""
        body_limit = max(100, max_length - len(prefix))
        current = ""

        def flush() -> None:
            nonlocal current
            if current:
                chunks.append(f"{prefix}{current}".strip())
                current = ""

        for paragraph in paragraphs:
            text = str(paragraph)
            if len(text) > body_limit:
                flush()
                for part in _split_long_text(text, body_limit, overlap):
                    chunks.append(f"{prefix}{part}".strip())
                continue

            next_text = f"{current}\n\n{text}" if current else text
            if len(next_text) > body_limit:
                flush()
            current = f"{current}\n\n{text}" if current else text

        flush()

    return [
        TextChunk(index=index, content=content)
        for index, content in enumerate(chunks)
    ]

