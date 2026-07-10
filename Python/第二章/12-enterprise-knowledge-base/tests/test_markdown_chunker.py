import unittest

from app.markdown_chunker import chunk_markdown, normalize_markdown


class MarkdownChunkerTest(unittest.TestCase):
    def test_chunk_by_heading_and_paragraph(self):
        chunks = chunk_markdown(
            "# 售后手册\n\n## 退款规则\n\n"
            + "超过 3000 元需要人工审核，审核人员需要核对订单状态、签收时间、商品类型和退款原因。"
            * 5
            + "\n\n普通商品签收后 7 天内可以申请退款。",
            120,
            10,
        )

        self.assertGreater(len(chunks), 1)
        self.assertIn("售后手册 / 退款规则", chunks[0].content)
        self.assertEqual([item.index for item in chunks], list(range(len(chunks))))

    def test_normalize_line_endings(self):
        self.assertEqual(normalize_markdown("a\r\n\r\nb\r\n"), "a\n\nb")

    def test_empty_document(self):
        self.assertEqual(chunk_markdown("   "), [])


if __name__ == "__main__":
    unittest.main()

