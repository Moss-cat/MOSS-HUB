/* MOSS 下载站 · script.js
 *
 * 共享存储版（Cloudflare R2 + Worker 后端）：
 *   · 上传的文件真正存进 R2 桶的 files/<id>，免费 10GB、出流量免费、不挤占 GitHub
 *   · 浏览器经 Cloudflare Worker 读写（密钥 x-moss-key 藏在 Worker 里，前端看不到）
 *   · 下载走 R2 公开地址（r2.dev），由 MOSS 浏览器（moss:dl）存到系统下载目录
 *   · 上传者（账号用户名）记录在 files/_index.json，下载页一眼可见
 *   · 举报写进 files/_reports.json，站长在「举报」标签页查看
 *   · 账号（注册/登录/7 天会话）仍是纯前端，只用于标记「谁上传的」
 *
 * 配置来自浏览器注入的 window.MOSS_CONFIG.files（api/pub/key 不进公开站点源码）。
 * 直接用普通浏览器打开本页面也能看下载列表（公开读），但上传/举报需要 MOSS 浏览器。
 */
"use strict";

var $ = function (id) { return document.getElementById(id); };

var LS_ACC = "moss_dl_account";     // { user, salt, hash, reg }
var LS_SES = "moss_dl_session";     // { user, seen }
var LS_REPORTED = "moss_dl_reported"; // [ fileId ] 本机已举报过的 id（仅 UI 状态）
var WEEK = 7 * 24 * 3600 * 1000;    // 一周

/* ---------------- 紧凑 SHA-256（密码只存哈希，不存明文） ---------------- */
var sha256 = (function () {
  function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
  return function (msg) {
    var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,
      0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
      0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,
      0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
      0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
      0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,
      0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
      0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
      0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
             0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var bytes = unescape(encodeURIComponent(msg));
    var withOne = bytes.length * 8 + 1;
    var total = Math.ceil((withOne + 64) / 512) * 512;
    var buf = new Array(total / 8).fill(0);
    for (var i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    buf[bytes.length] = 0x80;
    var bitLen = bytes.length * 8;
    for (var j = 0; j < 4; j++)
      buf[buf.length - 1 - j] = (bitLen >>> (8 * j)) & 0xff;
    function w32(o) {
      return (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
    }
    for (var off = 0; off < buf.length; off += 64) {
      var w = new Array(64);
      for (var t = 0; t < 16; t++) w[t] = w32(off + t * 4);
      for (t = 16; t < 64; t++) {
        var s0 = rr(w[t-15],7) ^ rr(w[t-15],18) ^ (w[t-15] >>> 3);
        var s1 = rr(w[t-2],17) ^ rr(w[t-2],19) ^ (w[t-2] >>> 10);
        w[t] = (w[t-16] + s0 + w[t-7] + s1) | 0;
      }
      var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) | 0;
        h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
      H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
    }
    return H.map(function (x) {
      return ("00000000" + ((x >>> 0).toString(16))).slice(-8);
    }).join("");
  };
})();

/* ---------------- localStorage 封装 ---------------- */
function lsGet(key, fallback) {
  try {
    var v = JSON.parse(localStorage.getItem(key) || "null");
    return (v === null || v === undefined) ? fallback : v;
  } catch (e) { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

/* ---------------- Cloudflare R2 + Worker 共享后端 ---------------- */
// 配置来自浏览器注入的 window.MOSS_CONFIG.files
var FC = (window.MOSS_CONFIG && window.MOSS_CONFIG.files) || null;
var API = FC ? (FC.api || "") : "";     // Worker 地址（读写，藏密钥）
var PUB = FC ? (FC.pub || "") : "";     // R2 公开读地址（下载用）
var KEY = FC ? (FC.key || "") : "";     // 写操作闸门（与 Worker 的 MOSS_KEY 一致）
// 能写 = 浏览器注入了有效的 api + key（即 MOSS 浏览器）
var CAN_WRITE = !!(API && KEY);

// 读接口优先走 Worker（带 CORS）；没有就退回 R2 公开地址（普通浏览器可见列表）
function readUrl(path) { return (API || PUB) + "/" + path; }
function apiUrl(path) { return API + "/" + path; }
function pubUrl(path) { return PUB + "/" + path; }

// GET 一个小 JSON（索引/举报）：404 返回 null，其它错误抛异常
async function getJsonViaWorker(path) {
  var resp = await fetch(readUrl(path));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error("读取失败 " + resp.status);
  return await resp.json();
}

// 公开读取索引：返回条目数组（任何异常都降级为空，不影响页面显示）
async function getIndex() {
  try {
    var j = await getJsonViaWorker("files/_index.json");
    var arr = j || [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
async function getReports() {
  try {
    var j = await getJsonViaWorker("files/_reports.json");
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}

// PUT 原始字节到 Worker（写文件本体或 JSON）
async function putRaw(path, body, contentType) {
  var resp = await fetch(apiUrl(path), {
    method: "PUT",
    headers: {
      "x-moss-key": KEY,
      "Content-Type": contentType || "application/octet-stream"
    },
    body: body
  });
  if (!resp.ok) {
    var err = await resp.text().catch(function () { return ""; });
    throw new Error("写入失败 " + resp.status + " " + err.slice(0, 160));
  }
}

// 读取-修改-写入一个 JSON 文件（带失败重试，R2 无 CAS，低并发足够）
async function rmwJson(path, mutate, message) {
  for (var attempt = 0; attempt < 4; attempt++) {
    var cur = null;
    try { cur = await getJsonViaWorker(path); } catch (e) { cur = null; }
    var data = Array.isArray(cur) ? cur : [];
    var next = mutate(data) || data;
    try {
      await putRaw(path, JSON.stringify(next), "application/json");
      return next;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(function (r) { setTimeout(r, 300 * (attempt + 1)); });
    }
  }
  throw new Error("更新失败，请重试");
}

// 下载地址：走 R2 公开读（moss:dl 会强制存到系统下载目录并改名）
function filePubUrl(entry) {
  return pubUrl("files/" + entry.id);
}

/* ---------------- 环境徽章 ---------------- */
(function () {
  var el = $("envBadge");
  if (CAN_WRITE) {
    el.textContent = "✓ MOSS 浏览器 · 可上传";
    el.className = "chip ok";
  } else {
    el.textContent = "⚠ 普通浏览器 · 仅查看";
    el.className = "chip warn";
  }
})();

/* ---------------- 账号门禁：注册 / 登录 / 7 天会话 ---------------- */
var session = null;

function showAuth(which) {
  $("auth").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("auth-reg").classList.toggle("hidden", which !== "reg");
  $("auth-login").classList.toggle("hidden", which !== "login");
  $("userBadge").classList.add("hidden");
}

function enterSite(user) {
  session = { user: user, seen: Date.now() };
  lsSet(LS_SES, session);
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("userName").textContent = user;
  $("userBadge").classList.remove("hidden");
  if (!CAN_WRITE) {
    $("upWarn").classList.remove("hidden");
  } else {
    $("upWarn").classList.add("hidden");
  }
  refreshAll();
}

function boot() {
  var acc = lsGet(LS_ACC, null);
  if (!acc) { showAuth("reg"); return; }          // 首次进入 → 注册
  var ses = lsGet(LS_SES, null);
  if (ses && ses.user === acc.user &&
      (Date.now() - (ses.seen || 0)) < WEEK) {
    enterSite(acc.user);                           // 7 天内来过 → 直接进
  } else {
    showAuth("login");                             // 一周没进 → 登录
  }
}

function authMsg(id, text, bad) {
  var el = $(id);
  el.textContent = text;
  el.className = "msg " + (bad ? "bad" : "good");
}

function doRegister() {
  var u = $("regUser").value.trim();
  var p = $("regPass").value;
  var p2 = $("regPass2").value;
  if (u.length < 2 || u.length > 20) {
    authMsg("regMsg", "用户名要 2-20 个字符", true); return;
  }
  if (p.length < 4) { authMsg("regMsg", "密码至少 4 位", true); return; }
  if (p !== p2) { authMsg("regMsg", "两次密码不一样", true); return; }
  var salt = Math.random().toString(36).slice(2, 10);
  lsSet(LS_ACC, { user: u, salt: salt, hash: sha256(salt + p), reg: Date.now() });
  authMsg("regMsg", "注册成功，正在进入…", false);
  setTimeout(function () { enterSite(u); }, 350);
}

function doLogin() {
  var acc = lsGet(LS_ACC, null);
  var u = $("logUser").value.trim();
  var p = $("logPass").value;
  if (!acc) { showAuth("reg"); return; }
  if (u !== acc.user || acc.hash !== sha256((acc.salt || "") + p)) {
    authMsg("logMsg", "用户名或密码不对（本机注册的是「" + acc.user + "」）", true);
    return;
  }
  authMsg("logMsg", "登录成功，正在进入…", false);
  setTimeout(function () { enterSite(acc.user); }, 350);
}

$("doReg").addEventListener("click", doRegister);
$("regPass2").addEventListener("keydown", function (e) {
  if (e.key === "Enter") doRegister();
});
$("doLog").addEventListener("click", doLogin);
$("logPass").addEventListener("keydown", function (e) {
  if (e.key === "Enter") doLogin();
});
$("reReg").addEventListener("click", function () {
  showAuth("reg");
  authMsg("regMsg", "注册新账号会替换本机旧账号", false);
});
$("logout").addEventListener("click", function () {
  try { localStorage.removeItem(LS_SES); } catch (e) {}
  session = null;
  showAuth("login");
});

/* ---------------- 标签页切换 ---------------- */
function show(view) {
  $("tab-dl").className = "tab" + (view === "dl" ? " active" : "");
  $("tab-up").className = "tab" + (view === "up" ? " active" : "");
  $("tab-rp").className = "tab" + (view === "rp" ? " active" : "");
  $("view-dl").className = "view" + (view === "dl" ? " active" : "");
  $("view-up").className = "view" + (view === "up" ? " active" : "");
  $("view-rp").className = "view" + (view === "rp" ? " active" : "");
}
$("tab-dl").addEventListener("click", function () { show("dl"); });
$("tab-up").addEventListener("click", function () { show("up"); });
$("tab-rp").addEventListener("click", function () { show("rp"); });

/* ---------------- 渲染文件列表 ---------------- */
var REASONS = ["垃圾广告 / 诈骗", "违法信息", "侵权 / 抄袭", "文件损坏或虚假", "其他"];

function fmtSize(n) {
  n = n || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}
function fmtTs(ts) {
  try {
    var d = new Date(ts || 0);
    return (d.getMonth() + 1) + "-" + d.getDate() + " " +
      ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  } catch (e) { return ""; }
}

function itemRow(name, info, actions, opts) {
  opts = opts || {};
  var row = document.createElement("div");
  row.className = "item";
  var ico = document.createElement("span");
  ico.className = "ico";
  ico.textContent = "📄";
  var meta = document.createElement("div");
  meta.className = "meta";
  var nm = document.createElement("div");
  nm.className = "name";
  nm.textContent = name;
  var sub = document.createElement("div");
  sub.className = "size";
  sub.textContent = fmtSize(info.size || 0) +
    (info.by ? " · 由 " + info.by + " 上传" : "") +
    (info.ts ? " · " + fmtTs(info.ts) : "");
  meta.appendChild(nm);
  meta.appendChild(sub);
  row.appendChild(ico);
  row.appendChild(meta);
  (actions || []).forEach(function (a) { row.appendChild(a); });
  if (opts.reasonBox) row.appendChild(opts.reasonBox);
  return row;
}

function dlButton(entry) {
  var b = document.createElement("a");
  b.className = "btn small primary";
  b.textContent = "下载";
  b.href = "moss:dl?url=" + encodeURIComponent(filePubUrl(entry)) +
           "&name=" + encodeURIComponent(entry.name);
  return b;
}

/* ---- 举报（写进仓库 _reports.json） ---- */
var reportedIds = lsGet(LS_REPORTED, []);
function saveReported() { lsSet(LS_REPORTED, reportedIds); }
function isReported(id) { return reportedIds.indexOf(id) >= 0; }

function reportButton(entry) {
  var b = document.createElement("button");
  b.className = "btn small warn";
  function refresh() {
    b.textContent = isReported(entry.id) ? "已举报" : "⚑ 举报";
    b.disabled = isReported(entry.id);
  }
  b.addEventListener("click", function () {
    if (b.disabled || !CAN_WRITE) return;
    var row = b.closest(".item");
    if (!row) return;
    var open = row.querySelector(".reasons");
    if (open) { open.remove(); return; }
    var box = document.createElement("div");
    box.className = "reasons";
    var label = document.createElement("span");
    label.className = "rlabel";
    label.textContent = "举报「" + entry.name + "」的理由：";
    box.appendChild(label);
    REASONS.forEach(function (r) {
      var c = document.createElement("button");
      c.className = "btn small";
      c.textContent = r;
      c.addEventListener("click", function () {
        rmwJson("files/_reports.json", function (list) {
          list.push({ id: entry.id, name: entry.name, reason: r,
                      ts: Date.now(), by: (session && session.user) || "匿名" });
          return list;
        }, "report " + entry.name).then(function () {
          if (reportedIds.indexOf(entry.id) < 0) reportedIds.push(entry.id);
          saveReported();
          box.remove();
          refresh();
          refreshReports();
        }).catch(function (err) {
          alert("举报失败：" + err.message);
        });
      });
      box.appendChild(c);
    });
    row.appendChild(box);
  });
  refresh();
  return b;
}

async function refreshDownloads() {
  var list = $("dlList");
  list.innerHTML = '<div class="empty">加载中…</div>';
  var entries = await getIndex();
  entries.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = '<div class="empty">还没有文件。去「上传页」传一个吧～</div>';
  } else {
    entries.forEach(function (e) {
      list.appendChild(itemRow(e.name, e, [dlButton(e), reportButton(e)]));
    });
  }
  $("dlCount").textContent = "（" + entries.length + " 个）";
}

async function refreshUploaded() {
  var list = $("upList");
  list.innerHTML = '<div class="empty">加载中…</div>';
  var entries = await getIndex();
  var me = (session && session.user) || "";
  var mine = entries.filter(function (e) { return e.by === me; });
  mine.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  list.innerHTML = "";
  if (!mine.length) {
    list.innerHTML = '<div class="empty">你还没上传过文件。</div>';
  } else {
    mine.forEach(function (e) {
      var del = document.createElement("button");
      del.className = "btn small";
      del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!confirm("删除「" + e.name + "」？此操作会同时移除下载列表里的它。")) return;
        delFile(e).then(refreshAll).catch(function (err) {
          alert("删除失败：" + err.message);
        });
      });
      list.appendChild(itemRow(e.name, e, [dlButton(e), del]));
    });
  }
  $("upCount").textContent = "（" + mine.length + " 个）";
}

async function refreshReports() {
  var list = $("rpList");
  list.innerHTML = "";
  var reports = await getReports();
  $("rpCount").textContent = "（" + reports.length + " 条）";
  if (!reports.length) {
    list.innerHTML = '<div class="empty">还没有举报记录。</div>';
    return;
  }
  reports.slice().reverse().forEach(function (r, idx) {
    var row = document.createElement("div");
    row.className = "item";
    var meta = document.createElement("div");
    meta.className = "meta";
    var nm = document.createElement("div");
    nm.className = "name";
    nm.textContent = r.name;
    var sub = document.createElement("div");
    sub.className = "size";
    sub.textContent = r.reason + " · " + fmtTs(r.ts) +
      (r.by ? " · 举报人 " + r.by : "");
    meta.appendChild(nm);
    meta.appendChild(sub);
    row.appendChild(meta);
    var clear = document.createElement("button");
    clear.className = "btn small";
    clear.textContent = "清除";
    clear.addEventListener("click", function () {
      rmwJson("files/_reports.json", function (list) {
        return list.filter(function (x) { return x.id !== r.id || x.ts !== r.ts; });
      }, "clear report " + r.name).then(refreshReports).catch(function (err) {
        alert("清除失败：" + err.message);
      });
    });
    row.appendChild(clear);
    list.appendChild(row);
  });
}

function refreshAll() {
  refreshDownloads();
  refreshUploaded();
  refreshReports();
}

/* ---------------- 上传 ---------------- */
async function uploadOne(file, who) {
  var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // 1) 传文件本体到 files/<id>（原始字节，content-type 透传，支持任意格式/大文件）
  await putRaw("files/" + id, file, file.type || "application/octet-stream");
  // 2) 把这条写进索引（读改写 + 失败重试）
  await rmwJson("files/_index.json", function (list) {
    list.push({ id: id, name: file.name, by: who, ts: Date.now(),
                size: file.size });
    return list;
  }, "index add " + file.name);
}

function handleFiles(list) {
  var arr = Array.prototype.slice.call(list || []);
  if (!arr.length) return;
  if (!CAN_WRITE) {
    $("upMsg").textContent = "当前不是 MOSS 浏览器，无法上传。请用 MOSS 浏览器打开 moss://download";
    $("upMsg").className = "msg bad";
    return;
  }
  var who = (session && session.user) || "匿名";
  var done = 0, ok = 0, failed = [];
  $("upMsg").textContent = "上传中… 0/" + arr.length;
  $("upMsg").className = "msg";
  arr.forEach(function (f) {
    uploadOne(f, who).then(function () {
      ok += 1; done += 1;
      if (done === arr.length) finish();
    }).catch(function (err) {
      failed.push(f.name + "：" + err.message);
      done += 1;
      if (done === arr.length) finish();
    });
  });
  function finish() {
    refreshAll();
    if (!failed.length) {
      $("upMsg").textContent = "已上传 " + ok + "/" + arr.length +
        " 个文件（上传者：" + who + "），下载页里现在能看到它们了。";
      $("upMsg").className = "msg good";
    } else {
      $("upMsg").textContent = "成功 " + ok + " 个，失败：" + failed.join("；");
      $("upMsg").className = "msg bad";
    }
  }
}

async function delFile(entry) {
  if (!CAN_WRITE) throw new Error("非 MOSS 浏览器，无法删除");
  // 1) 删文件本体
  var del = await fetch(apiUrl("files/" + entry.id), {
    method: "DELETE",
    headers: { "x-moss-key": KEY }
  });
  if (!del.ok && del.status !== 404) {
    throw new Error("删除文件失败 " + del.status);
  }
  // 2) 从索引移除
  await rmwJson("files/_index.json", function (list) {
    return list.filter(function (x) { return x.id !== entry.id; });
  }, "index remove " + entry.name);
}

var drop = $("drop");
var fileInput = $("file");
drop.addEventListener("click", function () { fileInput.click(); });
fileInput.addEventListener("change", function () {
  handleFiles(fileInput.files);
  fileInput.value = "";
});
drop.addEventListener("dragover", function (e) {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
drop.addEventListener("drop", function (e) {
  e.preventDefault();
  drop.classList.remove("over");
  handleFiles(e.dataTransfer.files);
});

/* ---------------- 启动：先过账号门禁 ---------------- */
boot();
