import { createApp } from "./server.js";
import { fillMailTemplate, parseMailTemplate } from "./mailer.js";

function assertEquals(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("作成、予約、管理、および二重予約の拒否", async () => {
  const dir = await Deno.makeTempDir();
  const sentMails = [];
  const handler = createApp({
    dataDir: dir,
    publicDir: "public",
    configPath: `${dir}/missing.json`,
    baseUrl: "https://kumikumi.example",
    sendMail: (mail) => sentMails.push(mail),
  });
  const call = (path, method = "GET", body) =>
    handler(
      new Request(`http://test${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body && JSON.stringify(body),
      }),
    );
  const createdResponse = await call("/api/schedules", "POST", {
    title: "面談",
    slotMinutes: 30,
    ranges: [{ start: "2030-01-01T00:00:00.000Z", end: "2030-01-01T01:00:00.000Z" }],
  });
  assertEquals(createdResponse.status, 201);
  const created = await createdResponse.json();
  assertEquals(created.bookingUrl, `/book/${created.id}`);
  if (!created.adminUrl.startsWith(`/admin/${created.id}?token=`)) {
    throw new Error("トークン付き管理URLが発行されていません");
  }
  const schedule = await (await call(`/api/schedules/${created.id}`)).json();
  assertEquals(schedule.slots.length, 2);
  const booking = {
    slot: schedule.slots[0],
    company: "テスト社",
    familyName: "山田",
    givenName: "太郎",
    email: "taro@example.jp",
  };
  const bookedResponse = await call(`/api/schedules/${created.id}/bookings`, "POST", booking);
  assertEquals(bookedResponse.status, 201);
  const booked = await bookedResponse.json();
  assertEquals(booked.mailSent, true);
  assertEquals(sentMails[0].email, "taro@example.jp");
  if (!sentMails[0].cancelUrl.startsWith("https://kumikumi.example/cancel/")) {
    throw new Error("確認メールに絶対URLのキャンセルURLが含まれていません");
  }
  if (!booked.cancelUrl.includes(`/cancel/${created.id}/`)) {
    throw new Error("キャンセルURLが発行されていません");
  }
  assertEquals((await call(`/api/schedules/${created.id}/bookings`, "POST", booking)).status, 409);
  const afterBooking = await (await call(`/api/schedules/${created.id}`)).json();
  assertEquals(afterBooking.slots.length, 2);
  assertEquals(afterBooking.occupiedSlots, [booking.slot]);
  const token = new URL(`http://test${created.adminUrl}`).searchParams.get("token");
  const admin = await (await call(`/api/admin/${created.id}?token=${token}`)).json();
  assertEquals(admin.bookings[0].email, "taro@example.jp");
  assertEquals(admin.bookings[0].familyName, "山田");
  assertEquals(admin.history[0].type, "registered");

  const cancelUrl = new URL(`http://test${booked.cancelUrl}`);
  const cancelApi = `/api/schedules/${created.id}/bookings/${
    cancelUrl.pathname.split("/").at(-1)
  }/cancel${cancelUrl.search}`;
  assertEquals((await call(cancelApi)).status, 200);
  assertEquals((await call(cancelApi, "POST")).status, 200);
  const afterCancel = await (await call(`/api/schedules/${created.id}`)).json();
  assertEquals(afterCancel.occupiedSlots, []);
  assertEquals((await call(cancelApi)).status, 404);
  const adminAfterCancel = await (await call(`/api/admin/${created.id}?token=${token}`)).json();
  assertEquals(adminAfterCancel.history.map((item) => item.type), ["registered", "cancelled"]);
  const updateMail = await call(`/api/admin/${created.id}?token=${token}`, "PATCH", {
    mailSubject: "{{title}} 更新後",
    mailBody: "{{familyName}}様 {{date}} {{cancelUrl}}",
  });
  assertEquals(updateMail.status, 200);
  const addSlots = await call(`/api/admin/${created.id}?token=${token}`, "PATCH", {
    ranges: [{ start: "2030-01-02T00:00:00.000Z", end: "2030-01-02T01:00:00.000Z" }],
  });
  assertEquals(addSlots.status, 200);
  assertEquals((await addSlots.json()).addedCount, 2);
  const adminAfterUpdate = await (await call(`/api/admin/${created.id}?token=${token}`)).json();
  assertEquals(adminAfterUpdate.mailSubject, "{{title}} 更新後");
  assertEquals(adminAfterUpdate.mailBody, "{{familyName}}様 {{date}} {{cancelUrl}}");
  assertEquals(adminAfterUpdate.slots.length, 4);
  assertEquals((await call(`/api/admin/${created.id}?token=wrong`, "PATCH", {})).status, 403);
  assertEquals((await call(`/api/admin/${created.id}?token=wrong`, "DELETE")).status, 403);
  assertEquals((await call(`/api/admin/${created.id}?token=${token}`, "DELETE")).status, 200);
  assertEquals((await call(`/api/schedules/${created.id}`)).status, 404);
  for (const type of ["schedules", "bookings", "history"]) {
    try {
      await Deno.stat(`${dir}/${type}/${created.id}.json`);
      throw new Error(`${type}のデータが削除されていません`);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
});

Deno.test("会社名、姓、名はすべて必須", async () => {
  const dir = await Deno.makeTempDir();
  const handler = createApp({
    dataDir: dir,
    publicDir: "public",
    configPath: `${dir}/missing.json`,
  });
  const createResponse = await handler(
    new Request("http://test/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "面談",
        slotMinutes: 30,
        ranges: [{ start: "2030-01-01T00:00:00.000Z", end: "2030-01-01T00:30:00.000Z" }],
      }),
    }),
  );
  const created = await createResponse.json();
  const schedule = await (await handler(new Request(`http://test/api/schedules/${created.id}`)))
    .json();
  const response = await handler(
    new Request(`http://test/api/schedules/${created.id}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slot: schedule.slots[0],
        company: "テスト社",
        familyName: "山田",
        email: "taro@example.jp",
      }),
    }),
  );
  assertEquals(response.status, 400);
});

Deno.test("メールテンプレートの差し込み", () => {
  assertEquals(
    fillMailTemplate("{{familyName}}様 {{title}} {{cancelUrl}}", {
      familyName: "山田",
      title: "面談",
      cancelUrl: "https://example.com/cancel",
    }),
    "山田様 面談 https://example.com/cancel",
  );
});

Deno.test("メールテンプレートのSubject行と本文を分離する", () => {
  assertEquals(
    parseMailTemplate("Subject: {{title}} 確認\r\n\r\n{{familyName}}様\r\n本文"),
    { subject: "{{title}} 確認", body: "{{familyName}}様\n本文" },
  );
});

Deno.test("メールのキャンセルURLにconfig.jsonのbaseURLを使用する", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({ baseURL: "https://reserve.example/base/" }),
  );
  const sentMails = [];
  const handler = createApp({
    dataDir: dir,
    publicDir: "public",
    configPath,
    sendMail: (mail) => sentMails.push(mail),
  });
  const post = (path, body) =>
    handler(
      new Request(`http://internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const created = await (await post("/api/schedules", {
    title: "面談",
    slotMinutes: 30,
    ranges: [{ start: "2030-01-01T00:00:00.000Z", end: "2030-01-01T00:30:00.000Z" }],
  })).json();
  const schedule = await (await handler(new Request(`http://internal/api/schedules/${created.id}`)))
    .json();
  const response = await post(`/api/schedules/${created.id}/bookings`, {
    slot: schedule.slots[0],
    company: "テスト社",
    familyName: "山田",
    givenName: "太郎",
    email: "taro@example.jp",
  });
  assertEquals(response.status, 201);
  if (!sentMails[0].cancelUrl.startsWith("https://reserve.example/cancel/")) {
    throw new Error(`baseURLが使われていません: ${sentMails[0].cancelUrl}`);
  }
});

Deno.test("メール送信に失敗した場合は予約を登録しない", async () => {
  const dir = await Deno.makeTempDir();
  const handler = createApp({
    dataDir: dir,
    publicDir: "public",
    configPath: `${dir}/missing.json`,
    sendMail: () => {
      throw new Error("SMTP error");
    },
  });
  const post = (path, body) =>
    handler(
      new Request(`http://test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const created = await (await post("/api/schedules", {
    title: "面談",
    slotMinutes: 30,
    ranges: [{ start: "2030-01-01T00:00:00.000Z", end: "2030-01-01T00:30:00.000Z" }],
  })).json();
  const schedulePath = `/api/schedules/${created.id}`;
  const schedule = await (await handler(new Request(`http://test${schedulePath}`))).json();
  const response = await post(`${schedulePath}/bookings`, {
    slot: schedule.slots[0],
    company: "テスト社",
    familyName: "山田",
    givenName: "太郎",
    email: "taro@example.jp",
  });
  assertEquals(response.status, 502);
  const afterFailure = await (await handler(new Request(`http://test${schedulePath}`))).json();
  assertEquals(afterFailure.occupiedSlots, []);
  const errorLog = await Deno.readTextFile(`${dir}/log/err.log`);
  if (!errorLog.includes("SMTP error") || !errorLog.includes(`schedule=${created.id}`)) {
    throw new Error("メール送信エラーがerr.logに記録されていません");
  }
});

Deno.test("config.jsonの表示設定だけを公開する", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      titleLogo: "https://example.com/logo.png",
      iconLogo: "https://example.com/icon.png",
      keyColor: "#123456",
      slotTime: 45,
      gmailAddress: "secret@example.com",
      appPassword: "secret",
    }),
  );
  const handler = createApp({ dataDir: dir, publicDir: "public", configPath });
  const config = await (await handler(new Request("http://test/api/config"))).json();
  assertEquals(config.titleLogo, "https://example.com/logo.png");
  assertEquals(config.iconLogo, "https://example.com/icon.png");
  assertEquals(config.keyColor, "#123456");
  assertEquals(config.slotTime, 45);
  assertEquals(config.authRequired, false);
  assertEquals(config.authenticated, true);
  assertEquals(config.mailSubject, "{{title}} くみくみ確認メール");
  if (!config.mailBody.includes("{{cancelUrl}}")) throw new Error("メール本文がありません");
  if ("gmailAddress" in config || "appPassword" in config) {
    throw new Error("メール認証情報が公開されています");
  }
});

Deno.test("表示設定がない場合は既定のロゴと緑を返す", async () => {
  const dir = await Deno.makeTempDir();
  const handler = createApp({
    dataDir: dir,
    publicDir: "public",
    configPath: `${dir}/missing.json`,
  });
  const config = await (await handler(new Request("http://test/api/config"))).json();
  assertEquals(config.titleLogo, "/logo.png");
  assertEquals(config.iconLogo, "/icon.png");
  assertEquals(config.keyColor, "#168458");
  assertEquals(config.slotTime, 30);
  assertEquals(config.authRequired, false);
  assertEquals(config.authenticated, true);
});

Deno.test("不正なslotTimeは30分にフォールバックする", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify({ slotTime: 0 }));
  const handler = createApp({ dataDir: dir, publicDir: "public", configPath });
  const config = await (await handler(new Request("http://test/api/config"))).json();
  assertEquals(config.slotTime, 30);
});

Deno.test("管理者認証を設定した場合はログイン後だけスケジュールを作成できる", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      adminUser: "admin",
      adminPass: "secret",
      cookieSecure: true,
      lifetimeSession: 1,
    }),
  );
  const handler = createApp({ dataDir: dir, publicDir: "public", configPath });
  const schedule = {
    title: "面談",
    slotMinutes: 30,
    ranges: [{ start: "2030-01-01T00:00:00.000Z", end: "2030-01-01T00:30:00.000Z" }],
  };
  const post = (path, body, cookie = "") =>
    handler(
      new Request(`http://test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
    );
  assertEquals((await post("/api/schedules", schedule)).status, 401);
  const pendingLogin = await post("/api/login", { user: "作成者", pass: "合言葉" });
  assertEquals(pendingLogin.status, 200);
  assertEquals((await pendingLogin.clone().json()).approved, false);
  const pendingCookie = pendingLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  const login = await post("/api/login", { user: "admin", pass: "secret" });
  assertEquals(login.status, 200);
  if (!login.headers.get("set-cookie")?.includes("Secure")) {
    throw new Error("cookieSecureがCookieに反映されていません");
  }
  if (!/Max-Age=3(?:599|600)/.test(login.headers.get("set-cookie") ?? "")) {
    throw new Error("lifetimeSessionがCookieへ反映されていません");
  }
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const sessionId = cookie.split("=")[1];
  if (!/^[0-9A-Za-z_-]{44}$/.test(sessionId)) {
    throw new Error("createSessionID形式のセッションIDではありません");
  }
  const createdResponse = await post("/api/schedules", schedule, cookie);
  assertEquals(createdResponse.status, 201);
  const created = await createdResponse.json();
  const unauthorizedList = await handler(new Request("http://test/api/admin/schedules"));
  assertEquals(unauthorizedList.status, 401);
  const mismatchedCookie = await handler(
    new Request("http://test/api/admin/schedules", {
      headers: { cookie: "kumikumi_session=not-an-approved-session" },
    }),
  );
  assertEquals(mismatchedCookie.status, 401);
  const listResponse = await handler(
    new Request("http://test/api/admin/schedules", { headers: { cookie } }),
  );
  assertEquals(listResponse.status, 200);
  const list = await listResponse.json();
  assertEquals(list.schedules.length, 1);
  assertEquals(list.schedules[0].title, "面談");
  assertEquals(list.schedules[0].creatorName, "admin");
  if (!list.schedules[0].adminUrl.startsWith(`/admin/${created.id}?token=`)) {
    throw new Error("一覧に管理URLがありません");
  }
  const users = await (await handler(
    new Request("http://test/api/admin/users", { headers: { cookie } }),
  )).json();
  assertEquals(users.users.length, 1);
  assertEquals(users.users[0].approved, false);
  assertEquals(users.users[0].passphrase, "合言葉");
  if ("passwordHash" in users.users[0]) throw new Error("パスワードハッシュが公開されています");
  const userId = users.users[0].id;
  assertEquals(
    (await handler(
      new Request(`http://test/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ approved: true, isAdmin: false }),
      }),
    )).status,
    200,
  );
  const approvedConfig = await (await handler(
    new Request("http://test/api/config", { headers: { cookie: pendingCookie } }),
  )).json();
  assertEquals(approvedConfig.authenticated, true);
  assertEquals(approvedConfig.role, "creator");
  assertEquals(
    (await handler(
      new Request("http://test/api/admin/schedules", { headers: { cookie: pendingCookie } }),
    )).status,
    200,
  );
  const creatorLogin = await post("/api/login", { user: "作成者", pass: "合言葉" });
  assertEquals((await creatorLogin.clone().json()).approved, true);
  const creatorCookie = creatorLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  assertEquals(
    (await post("/api/schedules", { ...schedule, title: "作成者の面談" }, creatorCookie)).status,
    201,
  );
  const creatorList = await (await handler(
    new Request("http://test/api/admin/schedules", { headers: { cookie: creatorCookie } }),
  )).json();
  assertEquals(
    creatorList.schedules.map((item) => item.title).sort(),
    ["作成者の面談", "面談"].sort(),
  );
  assertEquals(
    creatorList.schedules.find((item) => item.title === "作成者の面談").creatorName,
    "作成者",
  );
  assertEquals(
    (await handler(
      new Request("http://test/api/admin/users", { headers: { cookie: creatorCookie } }),
    )).status,
    403,
  );
  const logout = await handler(
    new Request("http://test/api/logout", { method: "POST", headers: { cookie } }),
  );
  assertEquals(logout.status, 200);
  if (!logout.headers.get("set-cookie")?.includes("Max-Age=0")) {
    throw new Error("ログアウト時にCookieが無効化されていません");
  }
  assertEquals(
    (await handler(new Request("http://test/api/admin/schedules", { headers: { cookie } }))).status,
    401,
  );
});

Deno.test("スケジュールごとのメールタイトルと本文を送信に使用する", async () => {
  const dir = await Deno.makeTempDir();
  const sentMails = [];
  const handler = createApp({
    dataDir: dir,
    publicDir: "public",
    configPath: `${dir}/missing.json`,
    sendMail: (mail) => sentMails.push(mail),
  });
  const post = (path, body) =>
    handler(
      new Request(`http://test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const created = await (await post("/api/schedules", {
    title: "面談",
    slotMinutes: 30,
    mailSubject: "面談の確認",
    mailBody: "{{familyName}}様 {{cancelUrl}}",
    ranges: [{ start: "2030-01-01T00:00:00.000Z", end: "2030-01-01T00:30:00.000Z" }],
  })).json();
  const schedule = await (await handler(new Request(`http://test/api/schedules/${created.id}`)))
    .json();
  await post(`/api/schedules/${created.id}/bookings`, {
    slot: schedule.slots[0],
    company: "テスト社",
    familyName: "山田",
    givenName: "太郎",
    email: "taro@example.jp",
  });
  assertEquals(sentMails[0].mailSubject, "面談の確認");
  assertEquals(sentMails[0].mailBody, "{{familyName}}様 {{cancelUrl}}");
});
