"""只还原字母后四个汉字数字，金额、数量仍由业务系统提供。"""

import re
DIGITS = dict(zip("零〇幺一二两三四五六七八九", "0011223456789"))


def normalize_order_ids(text):
    return re.sub(r"([A-Za-z])((?:[\s·．]*[零〇幺一二两三四五六七八九]){4})", lambda m: m[1] + "".join(DIGITS[c] for c in m[2] if c in DIGITS), text)
