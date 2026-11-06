import crypto from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, open, rename } from "node:fs/promises";
import path from "node:path";
const scrypt = promisify(crypto.scrypt);
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalize = (email) => String(email || "").trim().toLowerCase();
export class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export class AccountStore {
  constructor(directory, sendMail, now = Date.now) {
    this.file = path.join(directory, "accounts.json");
    this.sendMail = sendMail;
    this.now = now;
    this.tail = Promise.resolve();
    this.users = {};
    this.limits = /* @__PURE__ */ new Map();
  }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 448 });
    try {
      this.users = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.transaction(async () => {});
    }
    if (!this.users || Array.isArray(this.users) || typeof this.users !== "object") throw new Error("Invalid account store");
    for (const [email, user] of Object.entries(this.users)) {
      if (user.email !== email || typeof user.passHash !== "string" || typeof user.salt !== "string" || typeof user.userId !== "string" || typeof user.vaultId !== "string" || !/^[\w-]+$/.test(user.userId) || !/^[\w-]+$/.test(user.vaultId)) throw new Error("Invalid account record");
    }
  }
  async transaction(fn) {
    const next = this.tail.then(async () => {
      const before = structuredClone(this.users);
      try {
        const result = await fn();
        const temp = this.file + ".tmp";
        const file = await open(temp, "w", 384);
        try {
          await file.writeFile(JSON.stringify(this.users));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, this.file);
        const directory = await open(path.dirname(this.file), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return result;
      } catch (error) {
        this.users = before;
        throw error;
      }
    });
    this.tail = next.catch(() => {
    });
    return next;
  }
  limit(key, max = 8) {
    const now = this.now();
    for (const [k, item2] of this.limits) if (item2.until <= now) this.limits.delete(k);
    if (this.limits.size > 1e4) throw new AccountError(429, "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u0437\u0436\u0435");
    const item = this.limits.get(key) || { count: 0, until: now + 15 * 6e4 };
    item.count++;
    this.limits.set(key, item);
    if (item.count > max) throw new AccountError(429, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u043F\u043E\u043F\u044B\u0442\u043E\u043A. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0447\u0435\u0440\u0435\u0437 15 \u043C\u0438\u043D\u0443\u0442");
  }
  password(password) {
    if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024)
      throw new AccountError(400, "\u041F\u0430\u0440\u043E\u043B\u044C: \u043E\u0442 12 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432, \u043D\u0435 \u0431\u043E\u043B\u0435\u0435 1024 \u0431\u0430\u0439\u0442");
  }
  async hash(password, salt) {
    return (await scrypt(password, salt, 64)).toString("base64");
  }
  public(user) {
    return { userId: user.userId, email: user.email, vaultId: user.vaultId, epoch: user.epoch || 0 };
  }
  byId(id) {
    return Object.values(this.users).find((u) => u.userId === id);
  }
  async register(email, password, ip) {
    email = normalize(email);
    this.limit("register:" + ip, 5);
    if (!/^[^@\s]{1,128}@[^@\s]{1,128}\.[^@\s]{1,64}$/.test(email)) throw new AccountError(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 email");
    this.password(password);
    if (!this.sendMail) throw new AccountError(503, "\u0410\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440 \u0434\u043E\u043B\u0436\u0435\u043D \u043D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0443 \u043F\u0438\u0441\u0435\u043C");
    const salt = crypto.randomBytes(16).toString("hex");
    const passHash = await this.hash(password, salt);
    const token = crypto.randomBytes(32).toString("base64url");
    await this.transaction(async () => {
      if (this.users[email]) throw new AccountError(409, "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u0443\u0436\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442");
      this.users[email] = {
        userId: crypto.randomBytes(12).toString("base64url"),
        email,
        salt,
        passHash,
        vaultId: crypto.randomBytes(12).toString("base64url"),
        epoch: 0,
        verified: false,
        verifyHash: digest(token),
        verifyUntil: this.now() + 36e5
      };
    });
    await this.sendMail(email, "verify", token);
    return { verificationRequired: true };
  }
  async login(email, password, ip) {
    email = normalize(email);
    this.limit("login-ip:" + ip, 40);
    this.limit("login-email:" + email);
    if (typeof password !== "string" || Buffer.byteLength(password) > 1024) throw new AccountError(401, "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 email \u0438\u043B\u0438 \u043F\u0430\u0440\u043E\u043B\u044C");
    const u = this.users[email];
    const hash = await this.hash(password, u?.salt || "unknown-account");
    const equal = u && Buffer.byteLength(hash) === Buffer.byteLength(u.passHash) && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.passHash));
    if (!equal) throw new AccountError(401, "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 email \u0438\u043B\u0438 \u043F\u0430\u0440\u043E\u043B\u044C");
    if (!u.verified) throw new AccountError(403, "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435 email");
    return this.public(u);
  }
  async issue(email, kind, ip) {
    email = normalize(email);
    this.limit(kind + "-ip:" + ip, 10);
    this.limit(kind + "-email:" + email, 3);
    if (!this.sendMail) throw new AccountError(503, "\u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043F\u0438\u0441\u0435\u043C \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u0430");
    const token = crypto.randomBytes(32).toString("base64url");
    const present = await this.transaction(async () => {
      const u = this.users[email];
      if (!u || kind === "verify" && u.verified) return false;
      u[kind + "Hash"] = digest(token);
      u[kind + "Until"] = this.now() + 36e5;
      return true;
    });
    if (present) await this.sendMail(email, kind, token);
    return { message: "\u0415\u0441\u043B\u0438 \u0430\u043A\u043A\u0430\u0443\u043D\u0442 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442, \u043F\u0438\u0441\u044C\u043C\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E" };
  }
  async consume(email, token, kind, password) {
    email = normalize(email);
    if (typeof token !== "string" || token.length > 256) throw new AccountError(400, "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043A\u043E\u0434");
    if (kind === "reset") this.password(password);
    return this.transaction(async () => {
      const u = this.users[email];
      if (!u || u[kind + "Hash"] !== digest(token) || u[kind + "Until"] <= this.now()) throw new AccountError(400, "\u041A\u043E\u0434 \u043D\u0435\u0432\u0435\u0440\u0435\u043D \u0438\u043B\u0438 \u0438\u0441\u0442\u0451\u043A");
      delete u[kind + "Hash"];
      delete u[kind + "Until"];
      if (kind === "verify") u.verified = true;
      else {
        u.salt = crypto.randomBytes(16).toString("hex");
        u.passHash = await this.hash(password, u.salt);
        u.epoch = (u.epoch || 0) + 1;
      }
      return { message: kind === "verify" ? "Email \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D, \u0432\u043E\u0439\u0434\u0438\u0442\u0435" : "\u041F\u0430\u0440\u043E\u043B\u044C \u0438\u0437\u043C\u0435\u043D\u0451\u043D, \u0432\u043E\u0439\u0434\u0438\u0442\u0435 \u0437\u0430\u043D\u043E\u0432\u043E" };
    });
  }
  async migrate(record) {
    if (!record || normalize(record.email) !== record.email || typeof record.passHash !== "string" || typeof record.salt !== "string" || typeof record.userId !== "string" || typeof record.vaultId !== "string" || !/^[\w-]+$/.test(record.userId) || !/^[\w-]+$/.test(record.vaultId)) throw new Error("Invalid legacy account");
    return this.transaction(async () => {
      if (!this.users[record.email]) this.users[record.email] = { ...record, verified: false, epoch: 0 };
    });
  }
}
export function mailSender(env = process.env) {
  if (!env.MAIL_API_URL || !env.MAIL_API_TOKEN || !env.MAIL_FROM) return null;
  if (!env.MAIL_API_URL.startsWith("https://")) throw new Error("MAIL_API_URL must use HTTPS");
  return async (email, kind, token) => {
    const result = await fetch(env.MAIL_API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(15e3),
      headers: { Authorization: "Bearer " + env.MAIL_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [email],
        subject: kind === "verify" ? "Collab Notes: \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 email" : "Collab Notes: \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u0430\u0440\u043E\u043B\u044F",
        text: `\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u044D\u0442\u043E\u0442 \u043A\u043E\u0434 \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 Collab Notes: ${token}
\u041A\u043E\u0434 \u0434\u0435\u0439\u0441\u0442\u0432\u0443\u0435\u0442 1 \u0447\u0430\u0441. \u0415\u0441\u043B\u0438 \u0432\u044B \u043D\u0435 \u0437\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u043B\u0438 \u0435\u0433\u043E, \u0438\u0433\u043D\u043E\u0440\u0438\u0440\u0443\u0439\u0442\u0435 \u043F\u0438\u0441\u044C\u043C\u043E.`
      })
    });
    if (!result.ok) throw new AccountError(503, "\u041F\u0438\u0441\u044C\u043C\u043E \u043D\u0435 \u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E. \u0417\u0430\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u043A\u043E\u0434 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E");
  };
}
