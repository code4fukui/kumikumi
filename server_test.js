import { createApp } from "./server.js";
import { fillMailTemplate } from "./mailer.js";

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
});

Deno.test("会社名、姓、名はすべて必須", async () => {
  const dir = await Deno.makeTempDir();
  const handler = createApp({ dataDir: dir, publicDir: "public" });
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
      keyColor: "#123456",
      slotTime: 45,
      gmailAddress: "secret@example.com",
      appPassword: "secret",
    }),
  );
  const handler = createApp({ dataDir: dir, publicDir: "public", configPath });
  const config = await (await handler(new Request("http://test/api/config"))).json();
  assertEquals(config, {
    titleLogo: "https://example.com/logo.png",
    keyColor: "#123456",
    slotTime: 45,
  });
});

Deno.test("表示設定がない場合は既定のロゴと緑を返す", async () => {
  const dir = await Deno.makeTempDir();
  const handler = createApp({
    dataDir: dir,
    publicDir: "public",
    configPath: `${dir}/missing.json`,
  });
  const config = await (await handler(new Request("http://test/api/config"))).json();
  assertEquals(config, { titleLogo: "/logo.png", keyColor: "#168458", slotTime: 30 });
});

Deno.test("不正なslotTimeは30分にフォールバックする", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify({ slotTime: 0 }));
  const handler = createApp({ dataDir: dir, publicDir: "public", configPath });
  const config = await (await handler(new Request("http://test/api/config"))).json();
  assertEquals(config.slotTime, 30);
});
