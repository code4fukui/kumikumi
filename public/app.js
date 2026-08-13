const app = document.querySelector("#app");
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
const date = (iso) =>
  new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
const day = (iso) => new Intl.DateTimeFormat("ja-JP", { dateStyle: "full" }).format(new Date(iso));
const time = (iso) =>
  new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
async function request(path, options) {
  const r = await fetch(path, options);
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
  return data;
}
const field = (label, name, type = "text", required = true) =>
  `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" ${
    required ? "required" : ""
  }>`;
const bookingContactStorageKey = "kumikumi.bookingContact";

function restoreBookingContact(form) {
  try {
    const saved = JSON.parse(localStorage.getItem(bookingContactStorageKey) ?? "null");
    if (!saved || typeof saved !== "object") return;
    for (const name of ["company", "familyName", "givenName", "email"]) {
      if (typeof saved[name] === "string") form.elements[name].value = saved[name];
    }
  } catch {
    // localStorageが利用できない場合や保存内容が壊れている場合は、空欄のまま利用する。
  }
}

function saveBookingContact(form) {
  try {
    const contact = {};
    for (const name of ["company", "familyName", "givenName", "email"]) {
      contact[name] = form.elements[name].value;
    }
    localStorage.setItem(bookingContactStorageKey, JSON.stringify(contact));
  } catch {
    // ストレージの制限があっても予約操作は継続できるようにする。
  }
}

function createPage(config) {
  app.innerHTML =
    `<div class="page-actions"><a href="/manage">← 作成者ページへ戻る</a><button type="button" class="secondary logout">ログアウト</button></div><h1>新規スケジュール作成</h1><form id="create">${
      field("タイトル", "title")
    }<label for="minutes">1スロットの時間（分）</label><input id="minutes" name="slotMinutes" type="number" min="5" max="480" value="${config.slotTime}" required><label>予約可能日時</label><div id="dates"></div><button type="button" class="secondary" id="add-date">＋ 日付を追加</button><fieldset class="mail-settings"><legend>予約確認メール</legend><label for="mailSubject">メールタイトル</label><input id="mailSubject" name="mailSubject" value="${
      esc(config.mailSubject)
    }" maxlength="200" required><label for="mailBody">メール本文</label><textarea id="mailBody" name="mailBody" maxlength="20000" rows="12" required>${
      esc(config.mailBody)
    }</textarea><p class="template-help">差し込み項目: {{title}} {{date}} {{company}} {{familyName}} {{givenName}} {{cancelUrl}}</p></fieldset><p><button>スケジュールを作成</button></p><div id="message"></div></form>`;

  const addTime = (dateGroup) => {
    const row = document.createElement("div");
    row.className = "time-range";
    row.innerHTML =
      `<label>開始<input type="time" name="startTime" value="10:00" required></label><span>〜</span><label>終了<input type="time" name="endTime" value="12:00" required></label><button type="button" class="secondary remove-time" aria-label="時間帯を削除">削除</button>`;
    row.querySelector(".remove-time").onclick = () => row.remove();
    dateGroup.querySelector(".time-ranges").append(row);
  };
  const addDate = () => {
    const group = document.createElement("fieldset");
    group.className = "date-group";
    group.innerHTML =
      `<div class="date-heading"><label>日付<input type="date" name="date" required></label><button type="button" class="secondary remove-date">この日付を削除</button></div><div class="time-ranges"></div><button type="button" class="secondary add-time">＋ 時間を追加</button>`;
    group.querySelector(".remove-date").onclick = () => group.remove();
    group.querySelector(".add-time").onclick = () => addTime(group);
    document.querySelector("#dates").append(group);
    addTime(group);
  };
  addDate();
  document.querySelector("#add-date").onclick = addDate;
  bindLogout();
  document.querySelector("#create").onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.querySelector("#message");
    msg.textContent = "作成中…";
    try {
      const f = new FormData(e.target);
      const groups = [...document.querySelectorAll(".date-group")];
      const ranges = groups.flatMap((group) => {
        const selectedDate = group.querySelector('[name="date"]').value;
        return [...group.querySelectorAll(".time-range")].map((row) => ({
          start: new Date(`${selectedDate}T${row.querySelector('[name="startTime"]').value}`)
            .toISOString(),
          end: new Date(`${selectedDate}T${row.querySelector('[name="endTime"]').value}`)
            .toISOString(),
        }));
      });
      const body = {
        title: f.get("title"),
        slotMinutes: Number(f.get("slotMinutes")),
        mailSubject: f.get("mailSubject"),
        mailBody: f.get("mailBody"),
        ranges,
      };
      const result = await request("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      location.assign(result.adminUrl);
    } catch (err) {
      msg.className = "message error";
      msg.textContent = err.message;
    }
  };
}

function bindLogout() {
  document.querySelectorAll(".logout").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await request("/api/logout", { method: "POST" });
      } finally {
        location.assign("/");
      }
    };
  });
}

function loginPage(config) {
  app.innerHTML = `<p><a href="/">← トップへ戻る</a></p><h1>管理者ログイン</h1><form id="login">${
    field("ユーザー名", "user")
  }${
    field("パスワード", "pass", "password")
  }<p><button>ログイン</button></p><div id="message"></div></form>`;
  document.querySelector("#login").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("button");
    const msg = document.querySelector("#message");
    button.disabled = true;
    try {
      const result = await request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      if (result.approved) location.assign("/manage");
      else {
        msg.className = "message";
        msg.textContent = "利用申請を受け付けました。管理者の承認後にログインできます。";
        button.disabled = false;
      }
    } catch (err) {
      msg.className = "message error";
      msg.textContent = err.message;
      button.disabled = false;
    }
  };
}

function homePage(config) {
  app.innerHTML =
    `<h1>くみくみ</h1><p class="lead">空いている時間を組み合わせて、予約日程をかんたんに調整できるサービスです。</p><div class="home-features"><p>管理者が予約可能な日時を設定し、発行されたURLを相手へ共有できます。</p><p>予約者は希望時間を選ぶだけ。予約確認とキャンセル用URLはメールで届きます。</p></div><p><button id="show-login">管理者用ログイン</button></p><div id="login-area"></div>`;
  document.querySelector("#show-login").onclick = () => {
    if (!config.authRequired || config.authenticated) {
      location.assign("/manage");
      return;
    }
    const area = document.querySelector("#login-area");
    area.innerHTML = `<form id="login" class="inline-login">${field("ユーザー名", "user")}${
      field("パスワード", "pass", "password")
    }<p><button>ログイン</button></p><div id="message"></div></form>`;
    document.querySelector("#show-login").hidden = true;
    area.querySelector("#login").onsubmit = async (e) => {
      e.preventDefault();
      const button = e.target.querySelector("button");
      const msg = area.querySelector("#message");
      button.disabled = true;
      try {
        const result = await request("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
        });
        if (result.approved) location.assign("/manage");
        else {
          msg.className = "message";
          msg.textContent = "利用申請を受け付けました。管理者の承認後にログインできます。";
          button.disabled = false;
        }
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err.message;
        button.disabled = false;
      }
    };
    area.querySelector('[name="user"]').focus();
  };
}

async function managePage(config) {
  if (config.authRequired && !config.authenticated) {
    loginPage(config);
    return;
  }
  try {
    const result = await request("/api/admin/schedules");
    let usersHtml = "";
    if (["developer", "admin"].includes(result.role)) {
      const userResult = await request("/api/admin/users");
      usersHtml = `<section class="creator-management"><h2>作成者一覧</h2>${
        userResult.users.length
          ? `<div class="creator-list">${
            userResult.users.map((user) =>
              `<article data-user-id="${user.id}"><strong>${
                esc(user.name)
              }</strong><span class="passphrase"><small>合言葉</small>${
                user.passphrase === undefined ? "（未保存）" : esc(user.passphrase)
              }</span><label><input type="checkbox" name="approved" ${
                user.approved ? "checked" : ""
              }> 承認</label><label><input type="checkbox" name="isAdmin" ${
                user.isAdmin ? "checked" : ""
              }> 管理者</label><button type="button" class="danger delete-user">削除</button></article>`
            ).join("")
          }</div>`
          : "<p>作成者はいません。</p>"
      }</section>`;
    }
    app.innerHTML = `<div class="page-actions"><span>${
      esc(result.name)
    } としてログイン中</span><button type="button" class="secondary logout">ログアウト</button></div><div class="manage-heading"><h1>作成者ページ</h1><a class="button" href="/new">新規スケジュール作成</a></div><h2>作成済みスケジュール</h2>${
      result.schedules.length
        ? `<div class="schedule-list">${
          result.schedules.map((s) =>
            `<article><div><h3>${esc(s.title)}</h3><p>${date(s.createdAt)} 作成　作成者: ${
              esc(s.creatorName)
            }　予約 ${s.bookingCount} / ${s.slotCount}件</p></div><div class="schedule-actions"><a class="button" href="${
              esc(s.adminUrl)
            }">管理画面</a><a href="${
              esc(s.bookingUrl)
            }" target="_blank" rel="noopener noreferrer">予約ページ</a></div></article>`
          ).join("")
        }</div>`
        : '<p class="message">作成済みのスケジュールはありません。</p>'
    }${usersHtml}`;
    bindLogout();
    document.querySelectorAll(".creator-list article").forEach((row) => {
      const update = async () => {
        await request(`/api/admin/users/${row.dataset.userId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            approved: row.querySelector('[name="approved"]').checked,
            isAdmin: row.querySelector('[name="isAdmin"]').checked,
          }),
        });
      };
      row.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.onchange = async () => {
          if (!confirm("この作成者の権限を変更しますか？")) {
            input.checked = !input.checked;
            return;
          }
          await update();
        };
      });
      row.querySelector(".delete-user").onclick = async () => {
        if (!confirm("この作成者を削除しますか？")) return;
        await request(`/api/admin/users/${row.dataset.userId}`, { method: "DELETE" });
        row.remove();
      };
    });
  } catch (err) {
    if (err.status === 401) loginPage(config);
    else app.innerHTML = `<div class="message error">${esc(err.message)}</div>`;
  }
}

async function bookPage(id) {
  try {
    const s = await request(`/api/schedules/${id}`);
    const occupied = new Set(s.occupiedSlots);
    const slotsByDay = new Map();
    for (const slot of s.slots) {
      const key = day(slot);
      if (!slotsByDay.has(key)) slotsByDay.set(key, []);
      slotsByDay.get(key).push(slot);
    }
    app.innerHTML = `<h1>${
      esc(s.title)
    }</h1><p>希望時間帯を選んでください</p><p class="slot-duration">1枠 ${s.slotMinutes}分</p><div class="booking-days">${
      [...slotsByDay].map(([dateLabel, slots]) =>
        `<section class="booking-day"><h2>${esc(dateLabel)}</h2><div class="slots">${
          slots.map((slot) => {
            const isOccupied = occupied.has(slot);
            return `<button class="slot${isOccupied ? " occupied" : ""}" data-slot="${slot}" ${
              isOccupied ? "disabled" : ""
            }>${time(slot)}${isOccupied ? "（予約済み）" : ""}</button>`;
          }).join("")
        }</div></section>`
      ).join("") ||
      "予約可能な時間はありません。"
    }</div><form id="booking"><input type="hidden" name="slot"><div class="booking-fields"><div class="booking-field">${
      field("会社名", "company")
    }</div><div class="booking-field"><span class="field-label">姓名</span><div class="name-fields"><label for="familyName">姓<input id="familyName" name="familyName" required></label><label for="givenName">名<input id="givenName" name="givenName" required></label></div></div><div class="booking-field">${
      field("メールアドレス", "email", "email")
    }</div></div><p class="mail-notice">「この時間で予約」を押すと、設定されたメールアドレスから確認メールが送信されます。</p><p><button id="submit-booking" disabled>この時間で予約</button></p><p id="selected-slot" class="selected-slot" role="status">希望時間帯を選択してください。</p></form><div id="message"></div>`;
    document.querySelectorAll(".slot:not(:disabled)").forEach((b) =>
      b.onclick = () => {
        document.querySelectorAll(".slot").forEach((x) => x.classList.remove("selected"));
        b.classList.add("selected");
        const form = document.querySelector("#booking");
        form.slot.value = b.dataset.slot;
        document.querySelector("#submit-booking").disabled = false;
        document.querySelector("#selected-slot").textContent = `選択中: ${date(b.dataset.slot)}`;
      }
    );
    const form = document.querySelector("#booking");
    restoreBookingContact(form);
    for (const name of ["company", "familyName", "givenName", "email"]) {
      form.elements[name].addEventListener("input", () => saveBookingContact(form));
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      const msg = document.querySelector("#message");
      const submit = document.querySelector("#submit-booking");
      if (submit.disabled) return;
      submit.disabled = true;
      submit.classList.add("processing");
      submit.setAttribute("aria-busy", "true");
      submit.textContent = "予約処理中…";
      msg.className = "";
      msg.textContent = "";
      try {
        const body = Object.fromEntries(new FormData(form));
        saveBookingContact(form);
        const result = await request(`/api/schedules/${id}/bookings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        app.innerHTML = `<h1>予約しました</h1><div class="message"><p>${
          date(body.slot)
        } の予約を受け付けました。</p><p>確認メールを送信しました。</p><p>キャンセルする場合に必要なURLです。</p><p class="urls"><a href="${result.cancelUrl}">${location.origin}${result.cancelUrl}</a></p></div>`;
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err.message;
        submit.disabled = err.status === 409 || !form.slot.value;
        submit.classList.remove("processing");
        submit.removeAttribute("aria-busy");
        submit.textContent = "この時間で予約";
        if (err.status === 409) setTimeout(() => bookPage(id), 1800);
      }
    };
  } catch (err) {
    app.innerHTML = `<div class="message error">${esc(err.message)}</div>`;
  }
}

async function adminPage(id) {
  try {
    const s = await request(`/api/admin/${id}`);
    const adminTitle = `${s.title} - くみくみ管理画面`;
    document.title = adminTitle;
    const bySlot = new Map(s.bookings.map((b) => [b.slot, b]));
    const slotsByDay = new Map();
    for (const slot of s.slots) {
      const key = day(slot);
      if (!slotsByDay.has(key)) slotsByDay.set(key, []);
      slotsByDay.get(key).push(slot);
    }
    const bookingUrl = `${location.origin}/book/${id}`;
    app.innerHTML = `<p><a href="/manage">← 作成者ページへ戻る</a></p><h1>${
      esc(adminTitle)
    }</h1><div class="message"><p>この管理画面の操作には承認済みのログインが必要です。</p></div><p>予約 ${s.bookings.length} / ${s.slots.length}件</p><div class="urls share-url"><label for="booking-url">予約者向けURL</label><div><input id="booking-url" value="${bookingUrl}" readonly><a class="button" href="/book/${id}" target="_blank" rel="noopener noreferrer">新規ウィンドウで開く</a><button id="copy-booking-url" type="button">URLをコピー</button></div><p id="copy-status" class="copy-status" role="status"></p></div><div>${
      [...slotsByDay].map(([dateLabel, slots]) =>
        `<section class="admin-day"><h2>${
          esc(dateLabel)
        }</h2><div class="admin-scroll"><table><thead><tr><th>時間</th><th>会社名</th><th>姓名</th><th>メールアドレス</th></tr></thead><tbody>${
          slots.map((slot) => {
            const b = bySlot.get(slot);
            return `<tr><td>${time(slot)}</td><td>${b ? esc(b.company) : "空き"}</td><td>${
              b ? `${esc(b.familyName)} ${esc(b.givenName)}` : "—"
            }</td><td>${b ? esc(b.email) : "—"}</td></tr>`;
          }).join("")
        }</tbody></table></div></section>`
      ).join("")
    }</div><section class="history"><h2>登録・キャンセル履歴</h2>${
      s.history.length
        ? `<ul>${
          [...s.history].reverse().map((item) =>
            `<li><time>${date(item.at)}</time><strong>${
              item.type === "registered" ? "登録" : "キャンセル"
            }</strong><span>${date(item.slot)}　${esc(item.company)}　${esc(item.familyName)} ${
              esc(item.givenName)
            }　${esc(item.email)}</span></li>`
          ).join("")
        }</ul>`
        : "<p>履歴はありません。</p>"
    }</section><section class="admin-editor"><h2>予約枠を追加</h2><form id="add-slots"><div class="time-range"><label>日付<input type="date" name="date" required></label><label>開始<input type="time" name="start" value="10:00" required></label><label>終了<input type="time" name="end" value="12:00" required></label><button>追加</button></div><p class="template-help">1枠 ${s.slotMinutes}分で追加します。</p><div id="slot-update-message"></div></form></section><section class="admin-editor"><h2>予約確認メール</h2><form id="update-mail"><label for="admin-mail-subject">メールタイトル</label><input id="admin-mail-subject" name="mailSubject" value="${
      esc(s.mailSubject)
    }" maxlength="200" required><label for="admin-mail-body">メール本文</label><textarea id="admin-mail-body" name="mailBody" maxlength="20000" rows="12" required>${
      esc(s.mailBody)
    }</textarea><p class="template-help">差し込み項目: {{title}} {{date}} {{company}} {{familyName}} {{givenName}} {{cancelUrl}}</p><button>更新</button><div id="mail-update-message"></div></form></section><section class="delete-schedule"><h2>スケジュールの削除</h2><p>予約と履歴を含むすべてのデータが削除されます。この操作は取り消せません。</p><button id="delete-schedule" type="button" class="danger">このスケジュールを削除</button><div id="delete-message"></div></section>`;
    document.querySelector("#copy-booking-url").onclick = async () => {
      const status = document.querySelector("#copy-status");
      try {
        await navigator.clipboard.writeText(bookingUrl);
        status.textContent = "コピーしました";
      } catch {
        const input = document.querySelector("#booking-url");
        input.select();
        status.textContent = "URLを選択しました。コピー操作を行ってください";
      }
    };
    document.querySelector("#add-slots").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const msg = document.querySelector("#slot-update-message");
      const button = e.target.querySelector("button");
      button.disabled = true;
      try {
        const result = await request(`/api/admin/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ranges: [{
              start: new Date(`${f.get("date")}T${f.get("start")}`).toISOString(),
              end: new Date(`${f.get("date")}T${f.get("end")}`).toISOString(),
            }],
          }),
        });
        msg.className = "message";
        msg.textContent = `${result.addedCount}件の予約枠を追加しました。`;
        setTimeout(() => adminPage(id), 800);
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err.message;
        button.disabled = false;
      }
    };
    document.querySelector("#update-mail").onsubmit = async (e) => {
      e.preventDefault();
      const msg = document.querySelector("#mail-update-message");
      const button = e.target.querySelector("button");
      button.disabled = true;
      try {
        await request(`/api/admin/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
        });
        msg.className = "message";
        msg.textContent = "メール設定を更新しました。";
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
    document.querySelector("#delete-schedule").onclick = async () => {
      if (!confirm(`「${s.title}」を削除しますか？\n予約と履歴も削除され、元に戻せません。`)) {
        return;
      }
      const button = document.querySelector("#delete-schedule");
      const msg = document.querySelector("#delete-message");
      button.disabled = true;
      button.textContent = "削除中…";
      try {
        await request(`/api/admin/${id}`, {
          method: "DELETE",
        });
        location.assign("/manage");
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err.message;
        button.disabled = false;
        button.textContent = "このスケジュールを削除";
      }
    };
  } catch (err) {
    if (err.status === 401) location.assign("/");
    else app.innerHTML = `<div class="message error">${esc(err.message)}</div>`;
  }
}

async function cancelPage(scheduleId, bookingId) {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const endpoint = `/api/schedules/${scheduleId}/bookings/${bookingId}/cancel?token=${
    encodeURIComponent(token)
  }`;
  try {
    const booking = await request(endpoint);
    app.innerHTML = `<h1>予約のキャンセル</h1><div class="message"><p><strong>${
      esc(booking.title)
    }</strong></p><p>${date(booking.slot)}</p><p>${esc(booking.company)}　${
      esc(booking.familyName)
    } ${
      esc(booking.givenName)
    }</p></div><button id="cancel-booking" class="danger">予約をキャンセルする</button><div id="message"></div>`;
    document.querySelector("#cancel-booking").onclick = async () => {
      const button = document.querySelector("#cancel-booking");
      button.disabled = true;
      try {
        await request(endpoint, { method: "POST" });
        app.innerHTML =
          `<h1>キャンセルしました</h1><div class="message"><p>予約のキャンセルを受け付けました。</p><p><a class="button" href="/book/${scheduleId}">別日程で予約を取る</a></p></div>`;
      } catch (err) {
        button.disabled = false;
        const msg = document.querySelector("#message");
        msg.className = "message error";
        msg.textContent = err.message;
      }
    };
  } catch (err) {
    app.innerHTML = `<div class="message error">${esc(err.message)}</div>`;
  }
}

async function start() {
  let config = {
    titleLogo: "/logo.png",
    iconLogo: "/icon.png",
    keyColor: "#168458",
    slotTime: 30,
    authRequired: false,
    authenticated: true,
    mailSubject: "{{title}} くみくみ確認メール",
    mailBody: "",
  };
  try {
    config = await request("/api/config");
    document.querySelector("#title-logo").src = new URL(config.titleLogo, `${location.origin}/`);
    const iconUrl = new URL(config.iconLogo, `${location.origin}/`).href;
    document.querySelector("#favicon").href = iconUrl;
    document.querySelector("#apple-touch-icon").href = iconUrl;
    if (CSS.supports("color", config.keyColor)) {
      document.documentElement.style.setProperty("--key-color", config.keyColor);
    }
  } catch (err) {
    console.error("ロゴ設定を読み込めませんでした", err);
  }
  const match = location.pathname.match(/^\/(book|admin)\/([^/]+)$/);
  const cancelMatch = location.pathname.match(/^\/cancel\/([^/]+)\/([^/]+)$/);
  if (cancelMatch) cancelPage(cancelMatch[1], cancelMatch[2]);
  else if (location.pathname === "/") homePage(config);
  else if (location.pathname === "/manage") managePage(config);
  else if (location.pathname === "/new") {
    if (config.authRequired && !config.authenticated) loginPage(config);
    else createPage(config);
  } else if (match?.[1] === "book") bookPage(match[2]);
  else if (!match) app.innerHTML = '<div class="message error">ページが見つかりません</div>';
  else adminPage(match[2]);
}

start();
