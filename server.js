import { sendConfirmationMail } from "./mailer.js";

export function createApp(options = {}) {
  const dataDir = options.dataDir ?? "data";
  const publicDir = options.publicDir ?? "public";
  const sendMail = options.sendMail ?? sendConfirmationMail;
  const baseUrl = options.baseUrl;
  const configPath = options.configPath ?? "config.json";
  const locks = new Map();

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
      let keyColor = "#168458";
      let slotTime = 30;
      try {
        const config = JSON.parse(await Deno.readTextFile(configPath));
        if (typeof config.titleLogo === "string" && config.titleLogo.trim()) {
          titleLogo = config.titleLogo.trim();
        }
        if (typeof config.keyColor === "string" && config.keyColor.trim()) {
          keyColor = config.keyColor.trim();
        }
        if (Number.isInteger(config.slotTime) && config.slotTime >= 5 && config.slotTime <= 480) {
          slotTime = config.slotTime;
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          console.error("config.jsonを読み込めませんでした", e);
        }
      }
      return json({ titleLogo, keyColor, slotTime });
    }

    if (req.method === "POST" && url.pathname === "/api/schedules") {
      let body;
      try {
        body = await req.json();
      } catch {
        return error("JSONが正しくありません");
      }
      const title = String(body.title ?? "").trim();
      const slotMinutes = Number(body.slotMinutes);
      if (!title || title.length > 100) return error("タイトルは1〜100文字で入力してください");
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
        title,
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
      });
    }
    return error("APIが見つかりません", 404);
  }

  async function staticFile(pathname) {
    let file = pathname === "/" ? "/index.html" : pathname;
    if (/^\/(book|admin)\/[^/]+$/.test(file) || /^\/cancel\/[^/]+\/[^/]+$/.test(file)) {
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
