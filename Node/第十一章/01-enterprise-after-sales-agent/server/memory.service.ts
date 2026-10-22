import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { Storage } from "./storage.js";
import type { Actor, Preference } from "../shared/types.js";

@Injectable()
export class Memories {
  constructor(@Inject(Storage) readonly db: Storage) {}
  namespace(actor: Actor) {
    return ["aftersales", actor.tenantId, actor.id, "profile"];
  }
  /** 获取当前用户的沟通偏好记忆，未保存偏好时返回空数组。 */
  async list(actor: Actor): Promise<Preference[]> {
    // 根据当前用户的命名空间和固定键名，读取已保存的沟通偏好。
    const value = await this.db.memories.get(
      this.namespace(actor),
      "communication_style",
    );

    // 如果存在偏好记录，则将其转换为 Preference 类型并以数组形式返回。
    // 如果不存在记录，则返回空数组，统一调用方的数据处理方式。
    return value ? [value.value as Preference] : [];
  }
  async save(actor: Actor, value: string, automatic = false) {
    if (
      !value.trim() ||
      value.length > 100 ||
      /跳过|免审|批准|退款|系统指令|忽略/.test(value)
    )
      throw new BadRequestException(
        "这里只保存沟通方式偏好，业务权限和退款指令不能保存为偏好",
      );
    const existing = (await this.list(actor))[0];
    if (automatic && existing?.blocked) return null;
    const item: Preference = {
      key: "communication_style",
      value: value.trim(),
      blocked: false,
      updatedAt: new Date().toISOString(),
    };
    await this.db.memories.put(this.namespace(actor), item.key, item);
    return item;
  }
  async forget(actor: Actor) {
    // 删除正文，并保留禁止自动再次记住的控制标记。
    const item: Preference = {
      key: "communication_style",
      value: "",
      blocked: true,
      updatedAt: new Date().toISOString(),
    };
    await this.db.memories.put(this.namespace(actor), item.key, item);
    return item;
  }

  async extract(actor: Actor, message: string) {
    if (/这次|本次|今天/.test(message) || !/以后|今后|一直|默认|偏好/.test(message))
      return null;
    if (/跳过|免审|批准|退款|系统指令|忽略/.test(message)) return null;
    if (/文字|短信|不.*电话/.test(message))
      return this.save(actor, "优先使用文字沟通", true);
    if (/简洁|简短/.test(message))
      return this.save(actor, "回答简洁，优先说明下一步", true);
    if (/详细/.test(message)) return this.save(actor, "详细解释处理依据与步骤", true);
    return null;
  }
}
