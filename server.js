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
    const token = sessionToken(req);
    const value = sessions.get(token) ?? null;
    if (value && value.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return value;
  }

  function lifetimeMilliseconds(config) {
    const hours = typeof config.lifetimeSession === "number" &&
        Number.isFinite(config.lifetimeSession) && config.lifetimeSession > 0
      ? config.lifetimeSession
      : 24;
    return hours * 60 * 60 * 1000;
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
      let attributeName = "会社名";
      let authRequired = false;
      let adminLoginPath = "/admin-login";
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
        if (typeof config.attributeName === "string" && config.attributeName.trim()) {
          attributeName = config.attributeName.trim().slice(0, 100);
        }
        authRequired = Boolean(config.adminUser && config.adminPass);
        if (typeof config.adminLoginPath === "string" && /^\/[a-zA-Z0-9._/-]+$/.test(config.adminLoginPath)) {
          adminLoginPath = config.adminLoginPath;
        }
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
        attributeName,
        authRequired,
        authenticated: !authRequired || Boolean(actor),
        role: actor?.role ?? null,
        adminLoginPath,
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
        return error("IDとパスワードを入力してください");
      }
      const token = createSessionID();
      const expiresAt = Date.now() + lifetimeMilliseconds(config);
      let loginResult;
      if (name === config.adminUser && password === config.adminPass) {
        loginResult = { role: "developer", name, approved: true, expiresAt };
      } else {
        const users = await allUsers();
        let user = users.find((item) => item.name === name);
        const passwordHash = await hashPassword(password);
        if (!user) {
          user = {
            id: crypto.randomUUID(),
            name,
            passwordHash,
            approved: false,
            isAdmin: false,
            createdAt: new Date().toISOString(),
          };
          await write("users", user.id, user);
        } else if (user.passwordHash !== passwordHash) {
          return error("ユーザー名またはパスワードが正しくありません", 401);
        }
        loginResult = {
          role: user.isAdmin ? "admin" : "creator",
          name: user.name,
          userId: user.id,
          approved: user.approved,
          expiresAt,
        };
      }
      sessions.set(token, loginResult);
      const secure = config.cookieSecure === true ? "; Secure" : "";
      const maxAge = Math.max(0, Math.floor((loginResult.expiresAt - Date.now()) / 1000));
      return new Response(JSON.stringify({ ok: true, ...loginResult }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie":
            `kumikumi_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
        },
      });
    }

    const registrationMatch = url.pathname.match(/^\/api\/register\/([a-f0-9-]{36})$/);
    if (registrationMatch && req.method === "GET") {
      const invitation = await read("invitations", registrationMatch[1]);
      if (!invitation || invitation.usedAt) return error("登録URLが無効です", 404);
      return json({ ok: true, issuerName: invitation.issuerName });
    }
    if (registrationMatch && req.method === "POST") {
      const invitation = await read("invitations", registrationMatch[1]);
      if (!invitation || invitation.usedAt) return error("登録URLが無効です", 404);
      let body;
      try {
        body = await req.json();
      } catch {
        return error("JSONが正しくありません");
      }
      const name = String(body.user ?? "").trim();
      const password = String(body.pass ?? "");
      const passphrase = String(body.passphrase ?? "").trim();
      if (!name || !password || name.length > 100 || password.length > 200 || passphrase.length > 200) {
        return error("IDとパスワードを入力してください");
      }
      const users = await allUsers();
      if (users.some((user) => user.name === name)) return error("そのユーザー名は既に使われています", 409);
      const user = {
        id: crypto.randomUUID(),
        name,
        passwordHash: await hashPassword(password),
        ...(passphrase ? { passphrase } : {}),
        approved: false,
        isAdmin: false,
        invitedBy: invitation.issuerId,
        invitedByName: invitation.issuerName,
        createdAt: new Date().toISOString(),
      };
      await write("users", user.id, user);
      invitation.usedAt = user.createdAt;
      invitation.usedBy = user.id;
      await write("invitations", invitation.id, invitation);
      return json({ ok: true, approved: false }, 201);
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = sessionToken(req);
      sessions.delete(token);
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
      const visibleUsers = actor.role === "developer"
        ? await allUsers()
        : (await allUsers()).filter((user) => user.invitedBy === actor.userId);
      const users = visibleUsers.map(({ passwordHash: _, ...user }) => user);
      return json({ users, canSetAdmin: actor.role === "developer" || actor.role === "admin" });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/invitations") {
      const actor = await currentActor(req);
      if (!actor || !["developer", "admin"].includes(actor.role)) {
        return error("権限がありません", 403);
      }
      const id = crypto.randomUUID();
      await write("invitations", id, {
        id,
        issuerId: actor.userId ?? null,
        issuerName: actor.name,
        createdAt: new Date().toISOString(),
      });
      return json({ ok: true, inviteUrl: `/register/${id}` }, 201);
    }

    const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const actor = await currentActor(req);
      if (!actor || !["developer", "admin"].includes(actor.role)) {
        return error("権限がありません", 403);
      }
      const user = await read("users", userMatch[1]);
      if (!user) return error("作成者が見つかりません", 404);
      if (actor.role !== "developer" && user.invitedBy !== actor.userId) {
        return error("権限がありません", 403);
      }
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
              adminUrl: `/admin/${schedule.id}`,
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
      const additionalFieldEnabled = body.additionalFieldEnabled === true;
      const additionalFieldRequired = additionalFieldEnabled &&
        body.additionalFieldRequired === true;
      const additionalFieldLabel = String(body.additionalFieldLabel ?? "").trim();
      const slotMinutes = Number(body.slotMinutes);
      if (!title || title.length > 100) return error("タイトルは1〜100文字で入力してください");
      if (!mailSubject || mailSubject.length > 200) {
        return error("メールタイトルは1〜200文字で入力してください");
      }
      if (!mailBody || mailBody.length > 20_000) {
        return error("メール本文は1〜20000文字で入力してください");
      }
      if (additionalFieldEnabled && (!additionalFieldLabel || additionalFieldLabel.length > 200)) {
        return error("追加入力の説明は1〜200文字で入力してください");
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
      await write("schedules", id, {
        id,
        ownerId: actor?.userId ?? null,
        ownerName: actor?.name ?? "不明",
        title,
        mailSubject,
        mailBody,
        additionalFieldEnabled,
        additionalFieldRequired,
        additionalFieldLabel,
        slotMinutes,
        slots,
        createdAt: new Date().toISOString(),
      });
      return json(
        { id, bookingUrl: `/book/${id}`, adminUrl: `/admin/${id}` },
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
        additionalFieldEnabled: schedule.additionalFieldEnabled === true,
        additionalFieldRequired: schedule.additionalFieldRequired === true,
        additionalFieldLabel: schedule.additionalFieldLabel ?? "",
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
        const additionalText = String(body.additionalText ?? "").trim();
        const config = await getConfig();
        const attributeName =
          typeof config.attributeName === "string" && config.attributeName.trim()
            ? config.attributeName.trim().slice(0, 100)
            : "会社名";
        if (!company || !familyName || !givenName || !/^\S+@\S+\.\S+$/.test(email)) {
          return error(`${attributeName}、姓、名、正しいメールアドレスをすべて入力してください`);
        }
        if (![company, familyName, givenName, email].every((v) => v.length <= 200)) {
          return error("入力が長すぎます");
        }
        if (additionalText.length > 2000) return error("追加入力は2000文字以内で入力してください");
        if (
          schedule.additionalFieldEnabled && schedule.additionalFieldRequired && !additionalText
        ) {
          return error(`${schedule.additionalFieldLabel || "追加入力"}を入力してください`);
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
          additionalText: schedule.additionalFieldEnabled ? additionalText : "",
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
          additionalText: booking.additionalText,
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
      const actor = await currentActor(req);
      if (!actor) return error("ログインまたは承認が必要です", 401);
      const schedule = await read("schedules", adminMatch[1]);
      if (!schedule) return error("スケジュールが見つかりません", 404);
      return json({
        id: schedule.id,
        title: schedule.title,
        slotMinutes: schedule.slotMinutes,
        slots: schedule.slots,
        bookings: await read("bookings", schedule.id) ?? [],
        history: await read("history", schedule.id) ?? [],
        mailSubject: schedule.mailSubject ?? defaultMailSubject,
        mailBody: schedule.mailBody ?? defaultMailBody,
        additionalFieldEnabled: schedule.additionalFieldEnabled === true,
        additionalFieldRequired: schedule.additionalFieldRequired === true,
        additionalFieldLabel: schedule.additionalFieldLabel ?? "",
      });
    }
    if (req.method === "PATCH" && adminMatch) {
      const actor = await currentActor(req);
      if (!actor) return error("ログインまたは承認が必要です", 401);
      return await locked(adminMatch[1], async () => {
        const schedule = await read("schedules", adminMatch[1]);
        if (!schedule) return error("スケジュールが見つかりません", 404);
        let body;
        try {
          body = await req.json();
        } catch {
          return error("JSONが正しくありません");
        }
        if (body.title !== undefined) {
          const title = String(body.title ?? "").trim();
          if (!title || title.length > 100) {
            return error("タイトルは1〜100文字で入力してください");
          }
          schedule.title = title;
          schedule.updatedAt = new Date().toISOString();
          await write("schedules", schedule.id, schedule);
          return json({ ok: true, title });
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
        if (body.additionalFieldEnabled !== undefined) {
          const enabled = body.additionalFieldEnabled === true;
          const label = String(body.additionalFieldLabel ?? "").trim();
          if (enabled && (!label || label.length > 200)) {
            return error("追加入力の説明は1〜200文字で入力してください");
          }
          schedule.additionalFieldEnabled = enabled;
          schedule.additionalFieldRequired = enabled && body.additionalFieldRequired === true;
          schedule.additionalFieldLabel = label;
          schedule.updatedAt = new Date().toISOString();
          await write("schedules", schedule.id, schedule);
          return json({ ok: true });
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
      const actor = await currentActor(req);
      if (!actor) return error("ログインまたは承認が必要です", 401);
      return await locked(adminMatch[1], async () => {
        const schedule = await read("schedules", adminMatch[1]);
        if (!schedule) return error("スケジュールが見つかりません", 404);
        await remove("bookings", schedule.id);
        await remove("history", schedule.id);
        await remove("schedules", schedule.id);
        return json({ ok: true });
      });
    }
    return error("APIが見つかりません", 404);
  }

  async function staticFile(pathname, requestUrl) {
    let file = pathname === "/" ? "/index.html" : pathname;
    const routeConfig = await getConfig();
    const adminLoginPath = typeof routeConfig.adminLoginPath === "string" &&
        /^\/[a-zA-Z0-9._/-]+$/.test(routeConfig.adminLoginPath)
      ? routeConfig.adminLoginPath
      : "/admin-login";
    if (
      file === "/manage" || file === "/new" || file === adminLoginPath || /^\/(book|admin|register)\/[^/]+$/.test(file) ||
      /^\/cancel\/[^/]+\/[^/]+$/.test(file)
    ) {
      file = "/index.html";
    }
    if (!/^\/[a-zA-Z0-9._/-]+$/.test(file) || file.includes("..")) return null;
    try {
      let content = await Deno.readFile(`${publicDir}${file}`);
      const ext = file.split(".").pop();
      const types = {
        html: "text/html; charset=utf-8",
        css: "text/css; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        png: "image/png",
      };
      if (ext === "html") {
        const config = await getConfig();
        const configuredLogo = typeof config.titleLogo === "string" && config.titleLogo.trim()
          ? config.titleLogo.trim()
          : "/logo.png";
        let publicBase;
        try {
          publicBase = typeof config.baseURL === "string" && config.baseURL.trim()
            ? new URL("/", config.baseURL.trim())
            : new URL("/", requestUrl);
        } catch {
          publicBase = new URL("/", requestUrl);
        }
        let ogImage;
        try {
          const candidate = new URL(configuredLogo, publicBase);
          ogImage = ["http:", "https:"].includes(candidate.protocol)
            ? candidate.href
            : new URL("/logo.png", publicBase).href;
        } catch {
          ogImage = new URL("/logo.png", publicBase).href;
        }
        content = new TextEncoder().encode(
          new TextDecoder().decode(content).replaceAll("__OG_IMAGE__", ogImage),
        );
      }
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
      return await staticFile(url.pathname, url) ?? new Response("Not Found", { status: 404 });
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
