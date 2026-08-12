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

function createPage() {
  app.innerHTML = `<h1>予約スケジュールを作る</h1><form id="create">${
    field("タイトル", "title")
  }<label for="minutes">1スロットの時間（分）</label><input id="minutes" name="slotMinutes" type="number" min="5" max="480" value="30" required><label>予約可能日時</label><div id="dates"></div><button type="button" class="secondary" id="add-date">＋ 日付を追加</button><p><button>スケジュールを作成</button></p><div id="message"></div></form>`;

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
    form.onsubmit = async (e) => {
      e.preventDefault();
      const msg = document.querySelector("#message");
      try {
        const body = Object.fromEntries(new FormData(form));
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
        if (err.status === 409) setTimeout(() => bookPage(id), 1800);
      }
    };
  } catch (err) {
    app.innerHTML = `<div class="message error">${esc(err.message)}</div>`;
  }
}

async function adminPage(id) {
  try {
    const token = new URLSearchParams(location.search).get("token") ?? "";
    const s = await request(`/api/admin/${id}?token=${encodeURIComponent(token)}`);
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
    app.innerHTML = `<h1>${
      esc(adminTitle)
    }</h1><div class="message admin-bookmark"><strong>このページをブックマークしてください</strong><p>この管理画面はトークン付きの固有URLです。</p></div><p>予約 ${s.bookings.length} / ${s.slots.length}件</p><div class="urls share-url"><label for="booking-url">ユーザー向けURL</label><div><input id="booking-url" value="${bookingUrl}" readonly><a class="button" href="/book/${id}" target="_blank" rel="noopener noreferrer">新規ウィンドウで開く</a><button id="copy-booking-url" type="button">URLをコピー</button></div><p id="copy-status" class="copy-status" role="status"></p></div><div>${
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
    }</section>`;
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
  } catch (err) {
    app.innerHTML = `<div class="message error">${esc(err.message)}</div>`;
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
          `<h1>キャンセルしました</h1><div class="message">予約のキャンセルを受け付けました。</div>`;
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
  try {
    const config = await request("/api/config");
    document.querySelector("#title-logo").src = new URL(config.titleLogo, `${location.origin}/`);
    if (CSS.supports("color", config.keyColor)) {
      document.documentElement.style.setProperty("--key-color", config.keyColor);
    }
  } catch (err) {
    console.error("ロゴ設定を読み込めませんでした", err);
  }
  const match = location.pathname.match(/^\/(book|admin)\/([^/]+)$/);
  const cancelMatch = location.pathname.match(/^\/cancel\/([^/]+)\/([^/]+)$/);
  if (cancelMatch) cancelPage(cancelMatch[1], cancelMatch[2]);
  else if (!match) createPage();
  else if (match[1] === "book") bookPage(match[2]);
  else adminPage(match[2]);
}

start();
