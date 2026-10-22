const DIGITS: Record<string, string> = {
  零: "0",
  〇: "0",
  幺: "1",
  一: "1",
  二: "2",
  两: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
};

/**
 * 实时识别接口没有 ITN 开关，会把「A 一 零 二 四」原样写成汉字。
 * `agent.service.ts` 用 `/A\d{4}/` 抽取订单号，遇到汉字就匹配不到，后面整条处理建议都不会生成。
 *
 * 这里只还原「一个字母 + 紧邻的四个汉字数字」，也就是本项目订单号的固定形状（A1024）。
 * 不做整句数字换算：金额、数量由业务记录提供，改写它们只会引入新的不确定性。
 */
export function normalizeOrderIds(text: string) {
  return text.replace(
    // 数字之间可能夹空格：识别结果既可能是「A一零二四」，也可能是「A 一 零 二 四」。
    /([A-Za-z])((?:[\s·．]*[零〇幺一二两三四五六七八九]){4})/g,
    (_all, letter: string, run: string) =>
      letter +
      [...run]
        .filter((char) => DIGITS[char])
        .map((char) => DIGITS[char])
        .join(""),
  );
}
