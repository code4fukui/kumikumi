import { parseMailTemplate, sendConfirmationMail } from "./mailer.js";
import { createSessionID } from "https://code4fukui.github.io/sessionid/createSessionID.js";

export function createApp(options = {}) {
  const dataDir = options.dataDir ?? "data";
  const publicDir = options.publicDir ?? "public";
  const sendMail = options.sendMail ?? sendConfirmationMail;
  const baseUrl = options.baseUrl;
  const configPath = options.configPath ?? "config.json";
  const locks = new Map();
  const sessions = new Map();
  const defaultMailSubject = "{{title}} くみくみ確認メール";
  const defaultMailBody =
    "{{familyName}} {{givenName}} 様\n\n「{{title}}」の予約を受け付けました。\n日時: {{date}}\n\nキャンセル: {{cancelUrl}}";

  async function getDefaultMail() {
    try {
      return parseMailTemplate(await Deno.readTextFile("mail-template.txt"));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      return { subject: defaultMailSubject, body: defaultMailBody };
    }
  }

  const json = (value, status = 200) =>
    Response.json(value, {
      status,
      headers: { "cache-control": "no-store" },
    });
  const error = (message, status = 400) => json({ error: message }, status);
  const pathFor = (type, id) => `${dataDir}/${type}/${id}.json`;
  const validId = (id) => /^[a-f0-9-]{36}$/.test(id);

  async function read(type, id) {
    if (!validId(id)) return null;
    try {
      return JSON.parse(await Deno.readTextFile(pathFor(type, id)));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async function write(type, id, value) {
    const dir = `${dataDir}/${type}`;
    await Deno.mkdir(dir, { recursive: true });
    const path = pathFor(type, id);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temp, JSON.stringify(value, null, 2));
    await Deno.rename(temp, path);
  }

  async function remove(type, id) {
    try {
      await Deno.remove(pathFor(type, id));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  async function getConfig() {
    try {
      return JSON.parse(await Deno.readTextFile(configPath));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return {};
      throw e;
    }
  }

  function sessionToken(req) {
    const cookie = req.headers.get("cookie") ?? "";
    return cookie.match(/(?:^|;\s*)kumikumi_session=([^;]+)/)?.[1] ?? "";
  }

  function session(req) {
    return sessions.get(sessionToken(req)) ?? null;
  }

  async function hashPassword(password) {
    const bytes = new TextEncoder().encode(password);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function allUsers() {
    const users = [];
    try {
      for await (const entry of Deno.readDir(`${dataDir}/users`)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        const user = await read("users", id);
        if (user) users.push(user);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    return users;
  }

  async function currentActor(req) {
    const value = session(req);
    if (!value) return null;
    if (value.role === "developer") return value.approved ? value : null;
    if (!value.userId) return null;
    const user = await read("users", value.userId);
    if (!user?.approved) return null;
    return {
      userId: user.id,
      name: user.name,
      role: user.isAdmin ? "admin" : "creator",
      approved: true,
    };
  }

  async function getBaseUrl(requestUrl) {
    if (baseUrl) return baseUrl;
    try {
      const config = JSON.parse(await Deno.readTextFile(configPath));
      if (typeof config.baseURL === "string" && config.baseURL.trim()) {
        return new URL(config.baseURL.trim()).href;
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        console.error("config.jsonのbaseURLを読み込めませんでした", e);
      }
    }
    return requestUrl;
  }

  async function locked(key, fn) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => release = resolve);
    locks.set(key, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  function makeSlots(ranges, minutes) {
    const duration = minutes * 60_000;
    const slots = new Set();
    for (const range of ranges) {
      const start = Date.parse(range.start);
      const end = Date.parse(range.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw new Error("日時範囲が正しくありません");
      }
      for (let time = start; time + duration <= end; time += duration) {
        slots.add(new Date(time).toISOString());
        if (slots.size > 2000) throw new Error("スロット数は2000件以内にしてください");
      }
    }
    return [...slots].sort();
  }

  async function api(req, url) {
    if (req.method === "GET" && url.pathname === "/api/config") {
      let titleLogo = "/logo.png";
      let iconLogo = "/icon.png";
      let keyColor = "#168458";
      let slotTime = 30;
      let authRequired = false;
      let mailSubject = defaultMailSubject;
      let mailBody = "";
      try {
        const config = await getConfig();
        if (typeof config.titleLogo === "string" && config.titleLogo.trim()) {
          titleLogo = config.titleLogo.trim();
        }
        if (typeof config.iconLogo === "string" && config.iconLogo.trim()) {
          iconLogo = config.iconLogo.trim();
        }
        if (typeof config.keyColor === "string" && config.keyColor.trim()) {
          keyColor = config.keyColor.trim();
        }
        if (Number.isInteger(config.slotTime) && config.slotTime >= 5 && config.slotTime <= 480) {
          slotTime = config.slotTime;
        }
        authRequired = Boolean(config.adminUser && config.adminPass);
        const template = await getDefaultMail();
        mailSubject = template.subject;
        mailBody = template.body;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          console.error("config.jsonを読み込めませんでした", e);
        }
      }
      const actor = authRequired ? await currentActor(req) : session(req);
      return json({
        titleLogo,
        iconLogo,
        keyColor,
        slotTime,
        authRequired,
        authenticated: !authRequired || Boolean(actor),
        role: actor?.role ?? null,
        mailSubject,
        mailBody,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      let body;
      try {
        body = await req.json();
      } catch {
        return error("JSONが正しくありません");
      }
      const config = await getConfig();
      const name = String(body.user ?? "").trim();
      const password = String(body.pass ?? "");
      if (!name || !password || name.length > 100 || password.length > 200) {
        return error("ユーザー名とパスワードを入力してください");
      }
      const token = createSessionID();
      let loginResult;
      if (name === config.adminUser && password === config.adminPass) {
        loginResult = { role: "developer", name, approved: true };
      } else {
        const users = await allUsers();
        let user = users.find((item) => item.name === name);
        const passwordHash = await hashPassword(password);
        if (!user) {
          user = {
            id: crypto.randomUUID(),
            name,
            passwordHash,
            passphrase: password,
            approved: false,
            isAdmin: false,
            createdAt: new Date().toISOString(),
          };
          await write("users", user.id, user);
        } else if (user.passwordHash !== passwordHash) {
          return error("ユーザー名またはパスワードが正しくありません", 401);
        }
        if (user.passphrase === undefined) {
          user.passphrase = password;
          await write("users", user.id, user);
        }
        loginResult = {
          role: user.isAdmin ? "admin" : "creator",
          name: user.name,
          userId: user.id,
          approved: user.approved,
        };
      }
      sessions.set(token, loginResult);
      const secure = config.cookieSecure === true ? "; Secure" : "";
      return new Response(JSON.stringify({ ok: true, ...loginResult }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": `kumikumi_session=${token}; Path=/; HttpOnly; SameSite=Strict${secure}`,
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      sessions.delete(sessionToken(req));
      const config = await getConfig();
      const secure = config.cookieSecure === true ? "; Secure" : "";
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": `kumikumi_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      const actor = await currentActor(req);
      if (!actor || !["developer", "admin"].includes(actor.role)) {
        return error("権限がありません", 403);
      }
      const users = (await allUsers()).map(({ passwordHash: _, ...user }) => user);
      return json({ users, canSetAdmin: actor.role === "developer" || actor.role === "admin" });
    }

    const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const actor = await currentActor(req);
      if (!actor || !["developer", "admin"].includes(actor.role)) {
        return error("権限がありません", 403);
      }
      const user = await read("users", userMatch[1]);
      if (!user) return error("作成者が見つかりません", 404);
      if (req.method === "DELETE") {
        await remove("users", user.id);
        return json({ ok: true });
      }
      const body = await req.json();
      if (typeof body.approved === "boolean") user.approved = body.approved;
      if (typeof body.isAdmin === "boolean") user.isAdmin = body.isAdmin;
      await write("users", user.id, user);
      return json({ ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/schedules") {
      const actor = await currentActor(req);
      if (!actor) return error("ログインまたは承認が必要です", 401);
      const schedules = [];
      const userNames = new Map((await allUsers()).map((user) => [user.id, user.name]));
      try {
        for await (const entry of Deno.readDir(`${dataDir}/schedules`)) {
          if (!entry.isFile || !entry.name.endsWith(".json")) continue;
          try {
            const schedule = JSON.parse(
              await Deno.readTextFile(`${dataDir}/schedules/${entry.name}`),
            );
            const bookings = await read("bookings", schedule.id) ?? [];
            schedules.push({
              id: schedule.id,
              title: schedule.title,
              creatorName: schedule.ownerName ?? userNames.get(schedule.ownerId) ?? "不明",
              createdAt: schedule.createdAt,
              slotCount: schedule.slots.length,
              bookingCount: bookings.length,
              adminUrl: `/admin/${schedule.id}?token=${schedule.adminToken}`,
              bookingUrl: `/book/${schedule.id}`,
            });
          } catch (e) {
            console.error(`スケジュール ${entry.name} を読み込めませんでした`, e);
          }
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      schedules.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json({ schedules, role: actor.role, name: actor.name });
    }

    if (req.method === "POST" && url.pathname === "/api/schedules") {
      const config = await getConfig();
      const actor = await currentActor(req);
      if (config.adminUser && config.adminPass && !actor) {
        return error("ログインまたは承認が必要です", 401);
      }
      let body;
      try {
        body = await req.json();
      } catch {
        return error("JSONが正しくありません");
      }
      const title = String(body.title ?? "").trim();
      const defaultMail = await getDefaultMail();
      const mailSubject = String(body.mailSubject ?? defaultMail.subject).trim();
      const mailBody = String(body.mailBody ?? defaultMail.body).trim();
      const slotMinutes = Number(body.slotMinutes);
      if (!title || title.length > 100) return error("タイトルは1〜100文字で入力してください");
      if (!mailSubject || mailSubject.length > 200) {
        return error("メールタイトルは1〜200文字で入力してください");
      }
      if (!mailBody || mailBody.length > 20_000) {
        return error("メール本文は1〜20000文字で入力してください");
      }
      if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 480) {
        return error("1スロットは5〜480分で指定してください");
      }
      let slots;
      try {
        slots = makeSlots(body.ranges ?? [], slotMinutes);
      } catch (e) {
        return error(e.message);
      }
      if (!slots.length) return error("予約可能なスロットがありません");
      const id = crypto.randomUUID();
      const adminToken = crypto.randomUUID();
      await write("schedules", id, {
        id,
        adminToken,
        ownerId: actor?.userId ?? null,
        ownerName: actor?.name ?? "不明",
        title,
        mailSubject,
        mailBody,
        slotMinutes,
        slots,
        createdAt: new Date().toISOString(),
      });
      return json(
        { id, bookingUrl: `/book/${id}`, adminUrl: `/admin/${id}?token=${adminToken}` },
        201,
      );
    }

    const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
    if (req.method === "GET" && scheduleMatch) {
      const schedule = await read("schedules", scheduleMatch[1]);
      if (!schedule) return error("スケジュールが見つかりません", 404);
      const bookings = await read("bookings", schedule.id) ?? [];
      const occupied = new Set(bookings.map((b) => b.slot));
      return json({
        id: schedule.id,
        title: schedule.title,
        slotMinutes: schedule.slotMinutes,
        slots: schedule.slots,
        occupiedSlots: [...occupied],
      });
    }

    const bookingMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/bookings$/);
    if (req.method === "POST" && bookingMatch) {
      return await locked(bookingMatch[1], async () => {
        const schedule = await read("schedules", bookingMatch[1]);
        if (!schedule) return error("スケジュールが見つかりません", 404);
        let body;
        try {
          body = await req.json();
        } catch {
          return error("JSONが正しくありません");
        }
        const company = String(body.company ?? "").trim();
        const familyName = String(body.familyName ?? "").trim();
        const givenName = String(body.givenName ?? "").trim();
        const email = String(body.email ?? "").trim();
        const slot = String(body.slot ?? "");
        if (!company || !familyName || !givenName || !/^\S+@\S+\.\S+$/.test(email)) {
          return error("会社名、姓、名、正しいメールアドレスをすべて入力してください");
        }
        if (![company, familyName, givenName, email].every((v) => v.length <= 200)) {
          return error("入力が長すぎます");
        }
        if (!schedule.slots.includes(slot)) return error("選択された時間は予約できません");
        const bookings = await read("bookings", schedule.id) ?? [];
        if (bookings.some((booking) => booking.slot === slot)) {
          return error("この時間は先に予約されました。別の時間を選択してください", 409);
        }
        const booking = {
          id: crypto.randomUUID(),
          cancelToken: crypto.randomUUID(),
          slot,
          company,
          familyName,
          givenName,
          email,
          createdAt: new Date().toISOString(),
        };
        const cancelPath = `/cancel/${schedule.id}/${booking.id}?token=${
          encodeURIComponent(booking.cancelToken)
        }`;
        const cancelUrl = new URL(cancelPath, await getBaseUrl(req.url)).href;
        try {
          await sendMail({
            email: booking.email,
            title: schedule.title,
            date: new Intl.DateTimeFormat("ja-JP", {
              dateStyle: "full",
              timeStyle: "short",
              timeZone: "Asia/Tokyo",
            }).format(new Date(booking.slot)),
            company: booking.company,
            familyName: booking.familyName,
            givenName: booking.givenName,
            cancelUrl,
            mailSubject: schedule.mailSubject,
            mailBody: schedule.mailBody,
          });
        } catch (e) {
          console.error("予約確認メールを送信できませんでした", e);
          try {
            await Deno.mkdir(`${dataDir}/log`, { recursive: true });
            const detail = e instanceof Error ? e.stack ?? e.message : String(e);
            await Deno.writeTextFile(
              `${dataDir}/log/err.log`,
              `${new Date().toISOString()} schedule=${schedule.id} recipient=${booking.email} ${
                detail.replaceAll("\n", "\\n")
              }\n`,
              { append: true, create: true },
            );
          } catch (logError) {
            console.error("メール送信エラーをログへ記録できませんでした", logError);
          }
          return error("確認メールを送信できなかったため、予約を登録できませんでした", 502);
        }
        bookings.push(booking);
        await write("bookings", schedule.id, bookings);
        const history = await read("history", schedule.id) ?? [];
        history.push({
          type: "registered",
          bookingId: booking.id,
          slot: booking.slot,
          company: booking.company,
          familyName: booking.familyName,
          givenName: booking.givenName,
          email: booking.email,
          at: booking.createdAt,
        });
        await write("history", schedule.id, history);
        return json({
          ok: true,
          cancelUrl: cancelPath,
          mailSent: true,
        }, 201);
      });
    }

    const cancelMatch = url.pathname.match(
      /^\/api\/schedules\/([^/]+)\/bookings\/([^/]+)\/cancel$/,
    );
    if ((req.method === "GET" || req.method === "POST") && cancelMatch) {
      return await locked(cancelMatch[1], async () => {
        const schedule = await read("schedules", cancelMatch[1]);
        if (!schedule) return error("スケジュールが見つかりません", 404);
        const bookings = await read("bookings", schedule.id) ?? [];
        const index = bookings.findIndex((booking) => booking.id === cancelMatch[2]);
        if (index < 0) return error("この予約はキャンセル済みか、見つかりません", 404);
        const booking = bookings[index];
        if (url.searchParams.get("token") !== booking.cancelToken) {
          return error("キャンセルURLが正しくありません", 403);
        }
        if (req.method === "GET") {
          return json({
            title: schedule.title,
            slot: booking.slot,
            company: booking.company,
            familyName: booking.familyName,
            givenName: booking.givenName,
          });
        }
        bookings.splice(index, 1);
        await write("bookings", schedule.id, bookings);
        const history = await read("history", schedule.id) ?? [];
        history.push({
          type: "cancelled",
          bookingId: booking.id,
          slot: booking.slot,
          company: booking.company,
          familyName: booking.familyName,
          givenName: booking.givenName,
          email: booking.email,
          at: new Date().toISOString(),
        });
        await write("history", schedule.id, history);
        return json({ ok: true });
      });
    }

    const adminMatch = url.pathname.match(/^\/api\/admin\/([^/]+)$/);
    if (req.method === "GET" && adminMatch) {
      const schedule = await read("schedules", adminMatch[1]);
      if (!schedule) return error("スケジュールが見つかりません", 404);
      if (url.searchParams.get("token") !== schedule.adminToken) {
        return error("管理URLが正しくありません", 403);
      }
      return json({
        id: schedule.id,
        title: schedule.title,
        slotMinutes: schedule.slotMinutes,
        slots: schedule.slots,
        bookings: await read("bookings", schedule.id) ?? [],
        history: await read("history", schedule.id) ?? [],
        mailSubject: schedule.mailSubject ?? defaultMailSubject,
        mailBody: schedule.mailBody ?? defaultMailBody,
      });
    }
    if (req.method === "PATCH" && adminMatch) {
      return await locked(adminMatch[1], async () => {
        const schedule = await read("schedules", adminMatch[1]);
        if (!schedule) return error("スケジュールが見つかりません", 404);
        if (url.searchParams.get("token") !== schedule.adminToken) {
          return error("管理URLが正しくありません", 403);
        }
        let body;
        try {
          body = await req.json();
        } catch {
          return error("JSONが正しくありません");
        }
        if (body.ranges !== undefined) {
          let added;
          try {
            added = makeSlots(body.ranges, schedule.slotMinutes);
          } catch (e) {
            return error(e.message);
          }
          if (!added.length) return error("追加できる予約枠がありません");
          const previous = new Set(schedule.slots);
          schedule.slots = [...new Set([...schedule.slots, ...added])].sort();
          if (schedule.slots.length > 2000) return error("スロット数は2000件以内にしてください");
          schedule.updatedAt = new Date().toISOString();
          await write("schedules", schedule.id, schedule);
          return json({ ok: true, addedCount: added.filter((slot) => !previous.has(slot)).length });
        }
        const mailSubject = String(body.mailSubject ?? "").trim();
        const mailBody = String(body.mailBody ?? "").trim();
        if (!mailSubject || mailSubject.length > 200) {
          return error("メールタイトルは1〜200文字で入力してください");
        }
        if (!mailBody || mailBody.length > 20_000) {
          return error("メール本文は1〜20000文字で入力してください");
        }
        schedule.mailSubject = mailSubject;
        schedule.mailBody = mailBody;
        schedule.updatedAt = new Date().toISOString();
        await write("schedules", schedule.id, schedule);
        return json({ ok: true });
      });
    }
    if (req.method === "DELETE" && adminMatch) {
      return await locked(adminMatch[1], async () => {
        const schedule = await read("schedules", adminMatch[1]);
        if (!schedule) return error("スケジュールが見つかりません", 404);
        if (url.searchParams.get("token") !== schedule.adminToken) {
          return error("管理URLが正しくありません", 403);
        }
        await remove("bookings", schedule.id);
        await remove("history", schedule.id);
        await remove("schedules", schedule.id);
        return json({ ok: true });
      });
    }
    return error("APIが見つかりません", 404);
  }

  async function staticFile(pathname) {
    let file = pathname === "/" ? "/index.html" : pathname;
    if (
      file === "/manage" || file === "/new" || /^\/(book|admin)\/[^/]+$/.test(file) ||
      /^\/cancel\/[^/]+\/[^/]+$/.test(file)
    ) {
      file = "/index.html";
    }
    if (!/^\/[a-zA-Z0-9._/-]+$/.test(file) || file.includes("..")) return null;
    try {
      const content = await Deno.readFile(`${publicDir}${file}`);
      const ext = file.split(".").pop();
      const types = {
        html: "text/html; charset=utf-8",
        css: "text/css; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        png: "image/png",
      };
      return new Response(content, {
        headers: { "content-type": types[ext] ?? "application/octet-stream" },
      });
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  return async (req) => {
    try {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return await api(req, url);
      return await staticFile(url.pathname) ?? new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error(e);
      return error("サーバーエラーが発生しました", 500);
    }
  };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 8001);
  console.log(`くみくみ: http://localhost:${port}`);
  Deno.serve({ port }, createApp());
}
