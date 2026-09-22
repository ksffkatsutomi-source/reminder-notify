// リマインダボード プッシュ通知送信役（GitHub Actionsで10分ごとに実行）
// ・朝7時すぎ：きょうの予定まとめを1通
// ・時刻つきタスク：その時刻を過ぎた最初の実行で1通（1タスク1回だけ）
// ・こうき/あいか端末には🔒グループのタスクを送らない
const webpush = require("web-push");

const API_KEY = "AIzaSyC62SirRcWNRIQYnsjkdz5edjBu63OUCl4";
const PROJECT = "family-calendar-ea2b9";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const VAPID_PUB = "BHfzeA8wB7R5us8ybctWQIBrr_Zi9tu4Abt8KtHeChxvoHBnlXAAxufgXITUSUa5h0WLo-4Bweyo64GIoYAvtms";
const VAPID_PRV = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PRV) { console.error("VAPID_PRIVATE_KEY がありません（GitHub Secretsに設定してね）"); process.exit(1); }
webpush.setVapidDetails("https://family-calendar-ea2b9.web.app", VAPID_PUB, VAPID_PRV);

// JST現在時刻
const jnow = new Date(Date.now() + 9 * 3600 * 1000);
const pad = n => String(n).padStart(2, "0");
const TODAY = `${jnow.getUTCFullYear()}-${pad(jnow.getUTCMonth() + 1)}-${pad(jnow.getUTCDate())}`;
const NOWHM = `${pad(jnow.getUTCHours())}:${pad(jnow.getUTCMinutes())}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function auth() {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
    const j = await r.json();
    if (j.idToken) return j.idToken;
    console.log("auth retry:", JSON.stringify(j).slice(0, 200));
    await sleep(20000);
  }
  throw new Error("匿名認証に失敗");
}

const fv = f => { // Firestoreのvalueを素の値に
  if (!f) return "";
  if ("stringValue" in f) return f.stringValue;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("doubleValue" in f) return f.doubleValue;
  if ("booleanValue" in f) return f.booleanValue;
  return "";
};

async function main() {
  const tk = await auth();
  const H = { "Authorization": "Bearer " + tk, "Content-Type": "application/json" };

  // 購読端末（無ければ何もしない）
  const subsRes = await (await fetch(`${BASE}/reminder_push?pageSize=100`, { headers: H })).json();
  const subs = (subsRes.documents || []).map(d => ({
    path: d.name, id: d.name.split("/").pop(),
    sub: JSON.parse(fv(d.fields.sub)), role: fv(d.fields.role) || "admin"
  }));
  if (!subs.length) { console.log("購読端末なし"); return; }

  // グループ（🔒判定・名前）
  const meta = await (await fetch(`${BASE}/reminder_meta/board`, { headers: H })).json();
  const groups = {};
  ((meta.fields && meta.fields.groups && meta.fields.groups.arrayValue.values) || []).forEach(v => {
    const f = v.mapValue.fields;
    groups[fv(f.id)] = { name: fv(f.name), lock: fv(f.lock) === "1" };
  });

  // きょうが対応日のタスク
  const q = await (await fetch(`${BASE.replace(/\/documents$/, "")}/documents:runQuery`, {
    method: "POST", headers: H,
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "reminder_tasks" }], where: { fieldFilter: { field: { fieldPath: "due" }, op: "EQUAL", value: { stringValue: TODAY } } } } })
  })).json();
  const tasks = (Array.isArray(q) ? q : []).filter(r => r.document).map(r => {
    const f = r.document.fields;
    return { path: r.document.name, id: r.document.name.split("/").pop(),
      g: fv(f.g), title: fv(f.title), tm: fv(f.tm), done: fv(f.done), pid: fv(f.pid), ntf: fv(f.ntf) };
  }).filter(t => !t.done); // 済みは通知しない

  const visibleFor = role => tasks.filter(t => role !== "kid" || !(groups[t.g] && groups[t.g].lock));
  const dead = [];
  const send = async (s, payload) => {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload)); }
    catch (e) {
      const sc = e.statusCode || 0;
      console.log("send fail", s.id, sc);
      if (sc === 404 || sc === 410) dead.push(s);
    }
  };

  // ①朝のまとめ（7:00以降の最初の実行・1日1回）
  const state = await (await fetch(`${BASE}/reminder_push_meta/state`, { headers: H })).json();
  const lastDigest = state.fields ? fv(state.fields.digestDate) : "";
  if (NOWHM >= "07:00" && lastDigest !== TODAY) {
    for (const s of subs) {
      const list = visibleFor(s.role);
      if (!list.length) continue;
      const names = list.slice(0, 6).map(t => "・" + t.title + (t.tm ? `（${t.tm}）` : "")).join("\n");
      await send(s, { title: `📋 きょうの予定 ${list.length}件`, body: names + (list.length > 6 ? `\n…ほか${list.length - 6}件` : ""), tag: "digest-" + TODAY });
    }
    await fetch(`${BASE}/reminder_push_meta/state?updateMask.fieldPaths=digestDate`, {
      method: "PATCH", headers: H, body: JSON.stringify({ fields: { digestDate: { stringValue: TODAY } } })
    });
    console.log("digest sent");
  }

  // ②時刻つきタスク（時刻を過ぎたら1回だけ）
  for (const t of tasks) {
    if (!t.tm || t.tm > NOWHM || t.ntf === TODAY) continue;
    const gname = (groups[t.g] && groups[t.g].name) || "";
    for (const s of subs) {
      if (s.role === "kid" && groups[t.g] && groups[t.g].lock) continue;
      await send(s, { title: "⏰ " + t.title, body: `${gname}　きょう ${t.tm}`, tag: "tm-" + t.id });
    }
    await fetch(`${t.path.replace(/^projects.*?\/documents/, BASE)}?updateMask.fieldPaths=ntf`, {
      method: "PATCH", headers: H, body: JSON.stringify({ fields: { ntf: { stringValue: TODAY } } })
    });
    console.log("timed sent:", t.title);
  }

  // 期限切れ購読の掃除
  for (const s of dead) {
    await fetch(`${BASE}/reminder_push/${s.id}`, { method: "DELETE", headers: H });
    console.log("removed dead sub:", s.id);
  }
  console.log("done", TODAY, NOWHM, "subs:", subs.length, "tasks:", tasks.length);
}
main().catch(e => { console.error(e); process.exit(1); });
