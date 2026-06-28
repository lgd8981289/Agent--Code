"""读取 Markdown 文档，生成带稳定 ID 和 Metadata 的 Chunk。"""

import hashlib
import json
import re
from pathlib import Path
from typing import Any


lesson_dir = Path(__file__).resolve().parent
document_dir = lesson_dir / "documents"
output_dir = lesson_dir / "output"
output_file = output_dir / "chunks.json"

# 为了方便观察，这里按字符数控制 Chunk，而不是使用模型 Tokenizer。
CHUNK_MAX_LENGTH = 120
CHUNK_OVERLAP_LENGTH = 40


def sha256(text: str) -> str:
    """计算 UTF-8 文本的 SHA-256 哈希值。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_text(text: str) -> str:
    """统一换行、空格和空行，并删除首尾空白。"""
    text = text.replace("\r\n", "\n").replace("\t", " ")
    text = re.sub(r"[ ]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def read_meta_line(lines: list[str], name: str, fallback: str) -> str:
    """读取形如 `category: refund` 的元信息行。"""
    prefix = f"{name}:"
    line = next((item for item in lines if item.startswith(prefix)), None)
    return line.replace(prefix, "", 1).strip() if line else fallback


def parse_markdown(*, file_name: str, raw_text: str) -> dict[str, str]:
    """从 Markdown 中提取标题、Metadata 和清洗后的正文。"""
    normalized_text = normalize_text(raw_text)
    lines = normalized_text.split("\n")

    # 优先使用一级标题；没有一级标题时退回文件名。
    title_line = next((line for line in lines if line.startswith("# ")), None)
    title = re.sub(r"^#\s+", "", title_line).strip() if title_line else file_name

    category = read_meta_line(lines, "category", "unknown")
    owner = read_meta_line(lines, "owner", "unknown")
    source_version = read_meta_line(lines, "version", "v1")

    # 元信息单独放进 metadata，不重复保留在正文中。
    body_lines = [
        line
        for line in lines
        if not line.startswith(("category:", "owner:", "version:"))
    ]
    return {
        "fileName": file_name,
        "title": title,
        "category": category,
        "owner": owner,
        "sourceVersion": source_version,
        "text": normalize_text("\n".join(body_lines)),
    }


def split_long_paragraph(paragraph: str) -> list[str]:
    """把单个超长段落按固定字符数继续切分。"""
    parts = [
        paragraph[start : start + CHUNK_MAX_LENGTH].strip()
        for start in range(0, len(paragraph), CHUNK_MAX_LENGTH)
    ]
    return [part for part in parts if part]


def split_into_paragraphs(text: str) -> list[str]:
    """先按空行拆段，再把超长段落继续切小。"""
    paragraphs: list[str] = []
    for raw_paragraph in re.split(r"\n\s*\n", text):
        paragraph = raw_paragraph.replace("\n", " ").strip()
        if not paragraph:
            continue
        if len(paragraph) <= CHUNK_MAX_LENGTH:
            paragraphs.append(paragraph)
        else:
            paragraphs.extend(split_long_paragraph(paragraph))
    return paragraphs


def take_overlap(text: str) -> str:
    """从上一个 Chunk 末尾取一段内容，放到下一个 Chunk 开头。"""
    if CHUNK_OVERLAP_LENGTH <= 0:
        return ""
    return text[-CHUNK_OVERLAP_LENGTH:].strip()


def to_chunk_id(
    *,
    file_name: str,
    source_version: str,
    chunk_index: int,
    content: str,
) -> str:
    """用来源、版本、序号和内容哈希生成稳定 Chunk ID。"""
    source_name = re.sub(r"\.md$", "", file_name)
    content_hash = sha256(content)[:12]
    return f"{source_name}:{source_version}:{chunk_index:03d}:{content_hash}"


def create_chunks(document: dict[str, str]) -> list[dict[str, Any]]:
    """按段落和 overlap 把一份文档转换成结构化 Chunk。"""
    paragraphs = split_into_paragraphs(document["text"])
    chunk_contents: list[str] = []
    current: list[str] = []

    for paragraph in paragraphs:
        next_text = "\n\n".join([*current, paragraph])

        # 新段落加入后超长，就先保存当前 Chunk。
        if current and len(next_text) > CHUNK_MAX_LENGTH:
            content = "\n\n".join(current)
            chunk_contents.append(content)

            # 新 Chunk 带上上一块末尾的 overlap，减少语义被截断的问题。
            overlap = take_overlap(content)
            current = [overlap, paragraph] if overlap else [paragraph]
            continue

        current.append(paragraph)

    if current:
        chunk_contents.append("\n\n".join(current))

    chunks: list[dict[str, Any]] = []
    for index, content in enumerate(chunk_contents, start=1):
        content_hash = sha256(content)[:12]
        chunks.append(
            {
                "chunkId": to_chunk_id(
                    file_name=document["fileName"],
                    source_version=document["sourceVersion"],
                    chunk_index=index,
                    content=content,
                ),
                "content": content,
                "metadata": {
                    "source": document["fileName"],
                    "title": document["title"],
                    "category": document["category"],
                    "owner": document["owner"],
                    "sourceVersion": document["sourceVersion"],
                    "chunkIndex": index,
                    "contentHash": content_hash,
                    "chunkLength": len(content),
                },
            }
        )
    return chunks


def load_markdown_documents(
    directory: Path = document_dir,
) -> list[dict[str, str]]:
    """按文件名顺序加载 documents 目录中的全部 Markdown。"""
    markdown_files = sorted(
        path for path in directory.iterdir() if path.is_file() and path.suffix == ".md"
    )
    return [
        parse_markdown(
            file_name=path.name,
            raw_text=path.read_text(encoding="utf-8"),
        )
        for path in markdown_files
    ]


def build_chunks(
    *,
    source_directory: Path = document_dir,
    destination: Path = output_file,
) -> list[dict[str, Any]]:
    """读取全部文档、生成 Chunk，并写入 JSON 文件。"""
    if CHUNK_MAX_LENGTH <= 0:
        raise ValueError("CHUNK_MAX_LENGTH 必须大于 0。")
    if CHUNK_OVERLAP_LENGTH < 0:
        raise ValueError("CHUNK_OVERLAP_LENGTH 不能小于 0。")

    documents = load_markdown_documents(source_directory)
    chunks = [
        chunk
        for document in documents
        for chunk in create_chunks(document)
    ]

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(chunks, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"文档数量：{len(documents)}")
    print(f"Chunk 数量：{len(chunks)}")
    print(f"已写入：{destination}")
    print("\n前 3 个 Chunk：")
    for chunk in chunks[:3]:
        print(
            {
                "chunkId": chunk["chunkId"],
                "title": chunk["metadata"]["title"],
                "category": chunk["metadata"]["category"],
                "version": chunk["metadata"]["sourceVersion"],
                "length": chunk["metadata"]["chunkLength"],
            }
        )
    return chunks


if __name__ == "__main__":
    build_chunks()
