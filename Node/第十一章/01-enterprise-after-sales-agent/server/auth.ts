import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { accounts } from "./fixtures.js";
import { Storage } from "./storage.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

@Injectable()
export class Auth {
  constructor(@Inject(Storage) readonly db: Storage) {}
  async login(id: string, response: Response) {
    const actor = accounts.find((a) => a.id === id);
    if (!actor) throw new UnauthorizedException("演示账号不存在");
    const token = randomBytes(32).toString("hex");
    await this.db.pool.query(
      "INSERT INTO af_sessions(token_hash,actor_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [hash(token), actor.id],
    );
    response.cookie("af_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.COOKIE_SECURE === "true",
      path: "/api",
      maxAge: 86400000,
    });
    return actor;
  }
  async actor(request: Request) {
    const token = request.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("af_session="))
      ?.slice(11);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException("请先选择演示账号");
    const result = await this.db.pool.query(
      "SELECT actor_id FROM af_sessions WHERE token_hash=$1 AND expires_at>now()",
      [hash(token)],
    );
    const actor = accounts.find((a) => a.id === result.rows[0]?.actor_id);
    if (!actor) throw new UnauthorizedException("登录已过期，请重新选择账号");
    return actor;
  }
}
