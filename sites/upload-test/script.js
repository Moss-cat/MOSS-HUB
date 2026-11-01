/* 上传测试站 · script.js
 * 指令不写在这里——它由 MOSS 浏览器在加载站点时注入 window.MOSS_CONFIG.uploadPassword
 * （浏览器烘焙配置 moss/_baked.py）。普通浏览器里没有注入，上传页保持锁定。
 */
"use strict";

var $ = function (id) { return document.getElementById(id); };

var cfg = window.MOSS_CONFIG || null;
var PWD = (cfg && typeof cfg.uploadPassword === "string") ? cfg.uploadPassword : "";
var LS_KEY = "moss_uploadtest_files";

/* ---------------- 文件仓库（内存 + localStorage 尽力持久化） ---------------- */
var files = {}; // name -> { dataUrl, size, ts }

function seed(name, text) {
  files[name] = {
    dataUrl: "data:text/plain;charset=utf-8," + encodeURIComponent(text),
    size: new Blob([text]).size,
    ts: Date.now()
  };
}
seed("欢迎.txt",
  "欢迎来到 MOSS 上传测试站！\n" +
  "这个站点由 index.html + style.css + script.js 三个文件组成，\n" +
  "用于测试 MOSS 浏览器的多文件发布链路。\n");
seed("MOSS测试说明.txt",
  "· 下载页：完全免费，任何人都能下载\n" +
  "· 上传页：需要输入正确指令才能解锁\n" +
  "· 指令由 MOSS 浏览器内置配置注入，不写在站点源码里\n" +
  "· 上传的文件只存在本机 localStorage（测试用）\n");

try {
  var saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
  if (saved && typeof saved === "object") {
    for (var k in saved) if (saved.hasOwnProperty(k)) files[k] = saved[k];
  }
} catch (e) { /* moss: 方案可能不支持 localStorage，退化为纯内存 */ }

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(files)); } catch (e) {}
}

/* ---------------- 状态徽章：验证注入链路 ---------------- */
(function () {
  var el = $("cfgStatus");
  if (PWD) {
    el.textContent = "✓ MOSS_CONFIG 已注入（MOSS 浏览器）";
    el.className = "chip ok";
  } else {
    el.textContent = "✗ 未检测到 MOSS_CONFIG（普通浏览器）";
    el.className = "chip warn";
  }
})();

/* ---------------- 标签页切换 ---------------- */
function show(view) {
  $("tab-dl").className = "tab" + (view === "dl" ? " active" : "");
  $("tab-up").className = "tab" + (view === "up" ? " active" : "");
  $("view-dl").className = "view" + (view === "dl" ? " active" : "");
  $("view-up").className = "view" + (view === "up" ? " active" : "");
}
$("tab-dl").addEventListener("click", function () { show("dl"); });
$("tab-up").addEventListener("click", function () { show("up"); });

/* ---------------- 渲染文件列表 ---------------- */
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

function itemRow(name, info, actions) {
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
  var sz = document.createElement("div");
  sz.className = "size";
  sz.textContent = fmtSize(info.size || 0);
  meta.appendChild(nm);
  meta.appendChild(sz);
  row.appendChild(ico);
  row.appendChild(meta);
  (actions || []).forEach(function (a) { row.appendChild(a); });
  return row;
}

function dlButton(name, info) {
  var b = document.createElement("a");
  b.className = "btn small primary";
  b.textContent = "下载";
  b.href = info.dataUrl;
  b.download = name;
  return b;
}

function renderDownloads() {
  var list = $("dlList");
  list.innerHTML = "";
  var names = Object.keys(files).sort();
  names.forEach(function (name) {
    list.appendChild(itemRow(name, files[name], [dlButton(name, files[name])]));
  });
  $("dlCount").textContent = "（" + names.length + " 个）";
}

function renderUploaded() {
  var list = $("upList");
  list.innerHTML = "";
  var names = Object.keys(files).sort();
  names.forEach(function (name) {
    var del = document.createElement("button");
    del.className = "btn small";
    del.textContent = "删除";
    del.addEventListener("click", function () {
      delete files[name];
      persist();
      renderDownloads();
      renderUploaded();
    });
    list.appendChild(itemRow(name, files[name], [dlButton(name, files[name]), del]));
  });
  $("upCount").textContent = "（" + names.length + " 个）";
}

/* ---------------- 上传页：指令解锁 ---------------- */
var unlocked = false;
var attempts = 0;

function gateMsg(text, bad) {
  var el = $("gateMsg");
  el.textContent = text;
  el.className = "msg" + (bad ? " bad" : " good");
}

function tryUnlock() {
  if (!PWD) {
    gateMsg("本页需要用 MOSS 浏览器打开：浏览器内置配置里才有解锁指令，普通浏览器无法验证。", true);
    return;
  }
  var v = $("pwd").value;
  if (v === PWD) {
    unlocked = true;
    $("gate").classList.add("hidden");
    $("panel").classList.remove("hidden");
    gateMsg("解锁成功");
    renderUploaded();
  } else {
    attempts += 1;
    gateMsg("指令不对（第 " + attempts + " 次尝试），再想想。", true);
    var g = $("gate");
    g.classList.remove("shake");
    void g.offsetWidth; // 重新触发动画
    g.classList.add("shake");
  }
}
$("unlock").addEventListener("click", tryUnlock);
$("pwd").addEventListener("keydown", function (e) {
  if (e.key === "Enter") tryUnlock();
});

/* ---------------- 上传 ---------------- */
function handleFiles(list) {
  var arr = Array.prototype.slice.call(list || []);
  if (!arr.length) return;
  var done = 0, ok = 0;
  arr.forEach(function (f) {
    var r = new FileReader();
    r.onload = function () {
      files[f.name] = { dataUrl: String(r.result), size: f.size, ts: Date.now() };
      ok += 1;
      done += 1;
      if (done === arr.length) {
        persist();
        renderDownloads();
        renderUploaded();
        $("upMsg").textContent = "已上传 " + ok + "/" + arr.length +
          " 个文件（保存在本机），下载页里现在能看到它们了。";
        $("upMsg").className = "msg good";
      }
    };
    r.onerror = function () {
      done += 1;
      if (done === arr.length) {
        $("upMsg").textContent = "部分文件读取失败。";
        $("upMsg").className = "msg bad";
      }
    };
    r.readAsDataURL(f);
  });
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

/* ---------------- 初始渲染 ---------------- */
renderDownloads();
