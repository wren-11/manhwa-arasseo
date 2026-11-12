// 每次翻译都会注入一次，只初始化一次
if (!window.__manhwaTranslatorReady) {
  window.__manhwaTranslatorReady = true;

  const MIN_FONT = 8;
  const FONT_SIZES = { small: 16, medium: 22, large: 30 }; // 最大字号
  // 显示设置：tight = 只盖住原文那块，字自动缩小；grow = 字太小时把框撑大（字清楚但会挡画）
  let display = { boxMode: "tight", fontSize: "medium" };
  chrome.storage.local.get(["boxMode", "fontSize"]).then((v) => Object.assign(display, v));
  chrome.storage.onChanged.addListener((changes) => {
    for (const k of ["boxMode", "fontSize"]) if (changes[k]) display[k] = changes[k].newValue;
  });
  let host = null;
  let toastTimer = null;
  let activeRun = null; // 翻页模式下当前这次翻译的编号
  let inFlight = false;
  // 这里不是模块，用不了 i18n.js，只有几句提示，直接写在这里
  const zh = chrome.i18n.getUILanguage().toLowerCase().startsWith("zh");
  const TRANSLATING = zh ? "翻译中…" : "Translating…";

  const STYLE = `
        .box{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
          background:#fff;color:#111;border-radius:6px;padding:2px 3px;overflow:hidden;text-align:center;
          font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-weight:600;line-height:1.25;
          box-shadow:0 0 0 1px rgba(0,0,0,.08);word-break:break-all}
        .v{writing-mode:vertical-rl;text-orientation:upright;letter-spacing:.05em}
        .latin{word-break:normal;overflow-wrap:normal;hyphens:none;line-height:1.15;
          font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
        .dark{background:#111;color:#f5f5f5;box-shadow:none}
        .toast{position:fixed;top:16px;right:16px;max-width:320px;padding:10px 14px;border-radius:10px;
          background:rgba(20,20,20,.88);color:#fff;font:14px/1.4 -apple-system,"PingFang SC",sans-serif;
          box-shadow:0 4px 16px rgba(0,0,0,.25)}
        .toast.err{background:#b3261e}
        .track{position:absolute;left:0;top:0}
        .hidden{visibility:hidden}
        .fab{position:fixed;right:20px;bottom:20px;width:280px;max-width:calc(100vw - 40px);box-sizing:border-box;padding:12px 18px 14px;
          border-radius:14px;border:0;cursor:pointer;text-align:left;pointer-events:auto;
          background:rgba(20,20,20,.88);color:#fff;font:600 15px/1.35 -apple-system,"PingFang SC",sans-serif;
          box-shadow:0 6px 20px rgba(0,0,0,.3)}
        .fab:hover{background:rgba(20,20,20,.96)}
        .fab .sub{display:block;margin-top:2px;font-size:12px;font-weight:500;opacity:.75}
        .fab .bar{display:none;height:6px;margin-top:9px;border-radius:3px;background:rgba(255,255,255,.22);overflow:hidden}
        .fab .fill{height:100%;width:0;border-radius:3px;background:#fff;transition:width .4s ease}
        .fab.on{background:#1a5fd0}
        .fab.on .bar{display:block}
        .fab.paused{background:#8a5a00}
        .fab.paused .bar{display:block}
`;

  function ensureHost() {
    // 阅读器全屏时，覆盖层必须放进全屏元素里才看得到
    const parent = document.fullscreenElement || document.documentElement;
    if (!host) {
      host = document.createElement("div");
      host.dataset.manhwaTranslator = "";
      // 别让 Chrome 自带翻译或沉浸式翻译这类插件把译文再翻一遍（会把英文译文又机翻成中文）
      host.setAttribute("translate", "no");
      host.className = "notranslate";
      host.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${STYLE}
      </style><div id="layer" translate="no" class="notranslate"></div>`;
    }
    if (host.parentNode !== parent) parent.appendChild(host);
    return host.shadowRoot;
  }

  // 清掉翻页模式的译文和提示；条漫的译文贴在漫画上，单独管理
  function clear() {
    if (!host) return;
    for (const el of [...host.shadowRoot.getElementById("layer").children]) if (el !== strip?.fab) el.remove();
    clearTimeout(toastTimer);
  }

  // ---------- 条漫 ----------
  // 条漫是一条很长的滚动页面：译文放进 track，跟着滚动框一起移动，滚走了也不删，往回翻还在。
  // track 里的位置是"整条上的位置"：y = 截图时屏幕上的 y - 滚动框顶部 + 当时的滚动距离
  let strip = null; // { el, clip, track }
  let stripRuns = 0; // 正在翻的段数
  let lastScrolled = null;
  const docScroller = () => document.scrollingElement || document.documentElement;
  const isLong = (el) => el && el.isConnected && el.scrollHeight > el.clientHeight * 1.5 && el.clientHeight > innerHeight * 0.4;

  // 找画面中间正在显示漫画的那个滚动框：有的网站整个网页在滚，有的是页面里的一个框在滚
  function findScroller() {
    if (isLong(lastScrolled)) return lastScrolled;
    for (const fy of [0.5, 0.3, 0.7]) {
      let el = document.elementFromPoint(innerWidth / 2, innerHeight * fy);
      for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        const oy = getComputedStyle(el).overflowY;
        if (/(auto|scroll|overlay)/.test(oy) && isLong(el)) return el;
      }
    }
    return docScroller();
  }

  // 滚动框在屏幕上露出来的部分（CSS 像素）
  function rectOf(el) {
    if (el === docScroller()) return { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
    const r = el.getBoundingClientRect();
    return {
      top: Math.max(0, r.top),
      left: Math.max(0, r.left),
      right: Math.min(innerWidth, r.right),
      bottom: Math.min(innerHeight, r.bottom),
    };
  }

  // 整个网页在滚：放进 body；页面里的一个框在滚：放进那个框（它要是 static 定位，改成 relative，子元素才会跟着滚）
  function attachAnchor() {
    const parent = strip.el === docScroller() ? document.body : strip.el;
    if (parent !== document.body && getComputedStyle(parent).position === "static") parent.style.position = "relative";
    if (strip.anchor.parentNode !== parent) parent.appendChild(strip.anchor);
  }

  // 校准：让 track 的原点正好落在"整条上的 0 点"。网站的边框、padding、body 的偏移都由这里量出来补上。
  // 只在停下来、换位置时校准一次；滚动时由浏览器带着走，不用脚本追
  function placeTrack() {
    if (!strip) return;
    if (!strip.anchor.isConnected) attachAnchor(); // 网站重新渲染把它删了：放回去
    const r = rectOf(strip.el);
    const a = strip.anchor.getBoundingClientRect();
    const dx = r.left - a.left;
    const dy = r.top - strip.el.scrollTop - a.top;
    strip.track.style.transform = `translate(${dx}px, ${dy}px)`;
    strip.track.style.width = r.right - r.left + "px";
  }

  function resetStrip() {
    stripRuns = 0;
    prefetching = false;
    strip?.anchor.remove();
    strip?.fab.remove();
    strip = null;
  }

  // 网站在页面里直接换页（点返回、去下一话，网址变了但页面没重新加载），或者漫画那一栏被网站整个换掉了：
  // 上一话的译文和按钮都撤掉，告诉后台这一话翻过的记录作废。
  // 这个检查放在页面里自己做：后台闲置一会儿会被 Chrome 关掉，记不住网址，靠它通知不可靠
  setInterval(() => {
    if (!strip) return;
    if (strip.href === location.href.split("#")[0] && strip.el.isConnected) return;
    resetStrip();
    chrome.runtime.sendMessage({ type: "cleared" }).catch(() => {});
  }, 400);

  // 后台问：现在是不是条漫、滚到哪了
  function geom() {
    const el = findScroller();
    if (!isLong(el)) return resetStrip(), { strip: false };
    let fresh = false;
    if (strip?.el !== el) {
      resetStrip();
      const layer = ensureHost().getElementById("layer");
      // 用自定义标签名，网站自己写的 div 样式套不到它身上
      const anchor = document.createElement("manhwa-algetda-strip");
      anchor.dataset.manhwaTranslatorStrip = "";
      anchor.setAttribute("translate", "no");
      anchor.className = "notranslate";
      anchor.style.cssText =
        "all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483646;pointer-events:none;display:block;";
      const root = anchor.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${STYLE}</style><div class="track notranslate" translate="no"></div>`;
      strip = { el, anchor, track: root.querySelector(".track"), fab: makeFab(layer), href: location.href.split("#")[0] };
      attachAnchor();
      fresh = true;
    }
    ensureHost();
    placeTrack();
    const r = rectOf(el);
    const col = comicColumn(r);
    return {
      col,
      loading: siteLoading(),
      overlays: siteOverlays(r, col),
      strip: true,
      fresh,
      href: location.href.split("#")[0], // 只改 # 后面的不算换了一话
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      visible: document.visibilityState === "visible", // 切到别的标签页时截到的就不是漫画了
      dpr: devicePixelRatio,
      vw: innerWidth,
      vh: innerHeight,
      rect: r,
    };
  }

  // ---------- 整话预翻译按钮 ----------
  // 不点就和平常一样边看边翻；点了就自动往下滚完整话、截图翻译，再回到原来的位置
  let prefetching = false;
  // [主文字, 小字]
  const FAB_TEXT = {
    idle: () => (zh ? ["预翻译整话", "快速滑一遍，再回来从头看 · Option+Shift+K"] : ["Pre-translate episode", "Quick scan, then read from the top · Option+Shift+K"]),
    running: (m) =>
      m.fast
        ? zh ? [`快速扫描 ${m.pct}%`, "滑到底就回到原位，请别动页面 · 点击停止"] : [`Fast scan ${m.pct}%`, "Back to your spot at the end, hands off · click to stop"]
        : zh ? [`预翻译中 ${m.pct}%`, "正在滚动截图，请别动页面 · 点击停止"] : [`Pre-translating ${m.pct}%`, "Scrolling and capturing, hands off · click to stop"],
    paused: () => (zh ? ["已暂停", "回到这个页面会自动继续"] : ["Paused", "Resumes when you come back to this tab"]),
    translating: (m) =>
      m.stopped
        ? zh ? [`翻译中 ${m.done}/${m.total}`, "已停止截图，正在翻完已截好的部分"] : [`Translating ${m.done}/${m.total}`, "Capture stopped, finishing what was captured"]
        : zh ? [`翻译中 ${m.done}/${m.total}`, "可以开始看了，先翻你正在看的地方"] : [`Translating ${m.done}/${m.total}`, "Start reading, translating where you are first"],
    done: () => (zh ? ["整话已翻完 ✓", "个别没翻到的，看到那里会自动补上"] : ["Episode translated ✓", "Any misses fill in as you reach them"]),
    stopped: () => (zh ? ["已停止", "再点从当前位置继续"] : ["Stopped", "Click to continue from here"]),
  };
  function setFab(fab, [main, sub], pct) {
    fab.replaceChildren(main);
    const small = document.createElement("span");
    small.className = "sub";
    small.textContent = sub;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = (pct || 0) + "%";
    bar.appendChild(fill);
    fab.append(small, bar);
  }
  function makeFab(layer) {
    const fab = document.createElement("button");
    fab.className = "fab";
    setFab(fab, FAB_TEXT.idle());
    // 别让网站收到这次点击（有的阅读器点一下会切换工具栏）
    for (const type of ["pointerdown", "mousedown", "touchstart"]) fab.addEventListener(type, (e) => e.stopPropagation());
    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "prefetchToggle" }).catch(() => {});
    });
    layer.appendChild(fab);
    return fab;
  }
  let fabState = "idle";
  function prefetchState(msg) {
    const { state } = msg;
    prefetching = state === "running";
    fabState = state;
    if (!strip) return;
    const fab = strip.fab;
    const pct = state === "running" || state === "paused" ? msg.pct || 0 : state === "translating" ? Math.round((msg.done / Math.max(1, msg.total)) * 100) : 0;
    // 只改文字和进度条宽度，不重建元素，进度条才会平滑地涨
    const text = (FAB_TEXT[state] || FAB_TEXT.idle)(msg);
    const fill = fab.querySelector(".fill");
    if (fab.dataset.state === state && fill) {
      fab.firstChild.textContent = text[0];
      fab.querySelector(".sub").textContent = text[1];
      fill.style.width = pct + "%";
    } else {
      setFab(fab, text, pct);
      fab.dataset.state = state;
    }
    fab.classList.toggle("on", state === "running" || state === "translating");
    fab.classList.toggle("paused", state === "paused");
  }
  // 预翻译时由后台指挥滚到哪：滚过去、等图片加载好，再报告位置
  async function scrollStrip(y, quick) {
    if (!strip) return { strip: false };
    strip.el.scrollTop = y;
    // 标签页在后台时 requestAnimationFrame 不会触发，最多等 100 毫秒
    await new Promise((r) => (requestAnimationFrame(() => requestAnimationFrame(r)), setTimeout(r, 100)));
    let ready = true;
    const t0 = performance.now();
    if (!quick) {
      ready = await imagesReady();
      if (await siteLoaded()) ready = false; // 刚等过网站加载：不算"实心"，截两张比对确认画好了
      // 图片刚加载完要等它画到屏幕上（两帧）
      await new Promise((r) => (requestAnimationFrame(() => requestAnimationFrame(r)), setTimeout(r, 100)));
    }
    placeTrack();
    return { ...geom(), solid: ready && solidScreen(), waited: Math.round(performance.now() - t0) };
  }
  // 预翻译时用户自己动了：马上停，把屏幕还给用户
  const userTookOver = (e) => {
    if (prefetching && e.isTrusted) chrome.runtime.sendMessage({ type: "prefetchStop", why: e.type + (e.key ? " " + e.key : "") }).catch(() => {});
  };
  for (const type of ["wheel", "touchstart", "keydown"]) window.addEventListener(type, userTookOver, { capture: true, passive: true });

  // 网站固定在屏幕上的工具栏（position: fixed / sticky）：它们挡住的漫画截图里看不到
  function siteOverlays(r, col) {
    const found = new Set();
    const xs = [col.left + 12, (col.left + col.right) / 2, col.right - 12];
    const ys = [6, 30, 60, 100, 150].flatMap((d) => [r.top + d, r.bottom - d]);
    for (const x of xs)
      for (const y of ys)
        for (const el of document.elementsFromPoint(x, y)) {
          if (el === host || el === strip?.anchor || el === document.body || el === document.documentElement) continue;
          if (el === strip?.el || el.contains(strip?.el)) break; // 到了漫画本身那一层
          for (let a = el; a && a !== document.body; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.position !== "fixed" && cs.position !== "sticky") continue;
            if (cs.visibility === "hidden" || +cs.opacity < 0.1) break;
            const q = a.getBoundingClientRect();
            if (q.height > 0 && q.height < (r.bottom - r.top) * 0.4) found.add(a);
            break;
          }
        }
    return [...found].map((a) => {
      const q = a.getBoundingClientRect();
      return { left: q.left, top: q.top, right: q.right, bottom: q.bottom };
    });
  }

  // 漫画那一列在屏幕上的左右范围（条漫通常只占中间一列）：看按钮有没有真的挡住漫画用
  function comicColumn(r) {
    let left = Infinity;
    let right = -Infinity;
    for (const fy of [0.2, 0.4, 0.6, 0.8]) {
      const y = r.top + (r.bottom - r.top) * fy;
      for (const el of document.elementsFromPoint((r.left + r.right) / 2, y)) {
        if (el instanceof HTMLImageElement || el instanceof HTMLCanvasElement) {
          const q = el.getBoundingClientRect();
          if (q.width > 200) (left = Math.min(left, q.left)), (right = Math.max(right, q.right));
          break;
        }
      }
    }
    return left < right ? { left: Math.max(r.left, left), right: Math.min(r.right, right) } : { left: r.left, right: r.right };
  }

  // 截图前藏起这一段的译文和提示，截完再显示
  let hidden = [];
  // hideUi：按钮、提示挡住漫画时也藏起来（平常边看边翻用；预翻译时不藏，免得闪）
  function hide(y0, y1, hideUi) {
    const layer = ensureHost().getElementById("layer");
    hidden = [...layer.querySelectorAll(".box"), ...(strip?.track.children || [])].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > y0 && r.top < y1;
    });
    let ui = [...layer.querySelectorAll(".toast, .fab")];
    if (hideUi && strip) {
      const col = comicColumn(rectOf(strip.el));
      const blocking = ui.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > col.left && r.left < col.right && r.bottom > y0 && r.top < y1;
      });
      hidden.push(...blocking);
      ui = ui.filter((el) => !blocking.includes(el));
    }
    hidden.forEach((el) => el.classList.add("hidden"));
    return ui.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - 4, top: r.top - 4, right: r.right + 4, bottom: r.bottom + 4 };
    });
  }
  function show() {
    hidden.forEach((el) => el.classList.remove("hidden"));
    hidden = [];
  }

  // 等这一屏里的图片加载完（条漫网站常常先放空白占位，滚到了才加载）
  function imagesReady() {
    const vh = innerHeight;
    const waiting = [...document.images].filter((img) => {
      const r = img.getBoundingClientRect();
      if (!(r.width > 50 && r.bottom > 0 && r.top < vh)) return false;
      return !(img.complete && img.naturalWidth) || isPlaceholder(img, r);
    });
    if (!waiting.length) return Promise.resolve(true);
    const loaded = waiting.map(
      (img) => new Promise((r) => (img.addEventListener("load", r, { once: true }), img.addEventListener("error", r, { once: true })))
    );
    // true = 都加载好了；false = 等了 4 秒还没好
    return Promise.race([Promise.all(loaded).then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]);
  }

  // 网站自己的"正在加载"提示（比如 Lezhin 滑太快时中间弹出的「正在加载作品。」）：
  // 这时漫画画在画布上还没出来，截到的是空白，要等提示消失。在漫画那一栏上取一些点，看压在上面的元素写的是什么
  const LOADING = /加载|載入|讀取|불러오|로딩|로드 중|loading|読み込/i;
  function siteLoading() {
    if (!strip) return false;
    const r = rectOf(strip.el);
    const col = comicColumn(r);
    for (let i = 1; i <= 9; i++)
      for (let j = 1; j <= 5; j++) {
        const x = col.left + ((col.right - col.left) * j) / 6;
        const y = r.top + ((r.bottom - r.top) * i) / 10;
        for (const el of document.elementsFromPoint(x, y)) {
          if (el === host || el === strip.anchor || el === strip.el || el === document.body || el === document.documentElement) break;
          if (el instanceof HTMLImageElement || el instanceof HTMLCanvasElement) break; // 到了漫画本身
          const text = el.textContent;
          if (text && text.length < 40 && LOADING.test(text)) return true;
        }
      }
    return false;
  }
  // 等网站的加载提示消失（最多 6 秒）。返回有没有等过
  async function siteLoaded() {
    const t0 = performance.now();
    let waited = false;
    while (siteLoading() && performance.now() - t0 < 6000) {
      waited = true;
      await new Promise((r) => setTimeout(r, 150));
    }
    // 提示刚消失，画面还要画一下
    if (waited) await new Promise((r) => (requestAnimationFrame(() => requestAnimationFrame(r)), setTimeout(r, 200)));
    return waited;
  }

  // 懒加载网站常先放一张很小的占位图，显示得很大：这种还不算加载好
  const isPlaceholder = (img, r) => img.naturalWidth < 50 && r.width > 200;

  // 画面是不是"实心"的：这一屏主要由已经加载好的 <img> 组成，没有画布。
  // 是的话截一张就够了；画在画布上的网站看不出加载完没有，还是截两张比对
  function solidScreen() {
    if (!strip) return false;
    const r = rectOf(strip.el);
    let imgs = 0;
    let total = 0;
    for (let i = 1; i <= 7; i++)
      for (let j = 1; j <= 5; j++) {
        const x = r.left + ((r.right - r.left) * j) / 6;
        const y = r.top + ((r.bottom - r.top) * i) / 8;
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        total++;
        if (el instanceof HTMLCanvasElement || el.tagName === "VIDEO") return false;
        if (el instanceof HTMLImageElement) {
          if (!(el.complete && el.naturalWidth) || isPlaceholder(el, el.getBoundingClientRect())) return false;
          imgs++;
        }
      }
    return total > 0 && imgs / total >= 0.5;
  }

  let idleTimer = null;
  let idleToken = 0;
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target === document ? docScroller() : e.target;
      if (el instanceof Element && isLong(el)) lastScrolled = el;
      if (!strip || el !== strip.el) return;
      // 停下 0.35 秒、图片也加载好了，再请后台翻新露出来的部分
      clearTimeout(idleTimer);
      const token = ++idleToken;
      idleTimer = setTimeout(async () => {
        placeTrack(); // 网站停下后可能改了布局（工具栏收起之类），校准一次
        await imagesReady();
        await siteLoaded();
        if (token === idleToken) chrome.runtime.sendMessage({ type: "scrollIdle", scrollTop: strip?.el.scrollTop }).catch(() => {});
      }, 350);
    },
    { capture: true, passive: true }
  );

  function toast(text, isError, ms) {
    const root = ensureHost();
    const layer = root.getElementById("layer");
    layer.querySelector(".toast")?.remove();
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " err" : "");
    el.textContent = text;
    layer.appendChild(el);
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => el.remove(), ms);
  }

  const READABLE_FONT = 13; // 小于这个字号就先把框撑大，而不是继续缩字
  const overflowing = (el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;

  function shrinkFont(el, floor) {
    let size = parseFloat(el.style.fontSize);
    while (size > floor && overflowing(el)) {
      size -= 1;
      el.style.fontSize = size + "px";
    }
  }

  function fit(el) {
    const maxFont = FONT_SIZES[display.fontSize] || FONT_SIZES.medium;
    const size = Math.min(maxFont, Math.max(MIN_FONT, Math.min(el.clientWidth, el.clientHeight) * 0.5));
    el.style.fontSize = size + "px";
    if (display.boxMode !== "grow") return shrinkFont(el, MIN_FONT);
    shrinkFont(el, READABLE_FONT);
    // 竖排的旁白框往往比中文译文窄：往左加列（竖排从右往左排），横排的往下加行
    const vertical = el.classList.contains("v");
    for (let i = 0; i < 8 && overflowing(el); i++) {
      if (vertical) {
        const w = el.offsetWidth * 1.25;
        el.style.left = parseFloat(el.style.left) - (w - el.offsetWidth) + "px";
        el.style.width = w + "px";
      } else {
        el.style.height = el.offsetHeight * 1.25 + "px";
      }
    }
    shrinkFont(el, MIN_FONT);
  }

  // 中日韩文字（含假名、全角标点）
  const CJK = /[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;

  // anchor：条漫的框，截图时的滚动距离和滚动框位置
  function addBox(it, anchor) {
    const layer = ensureHost().getElementById("layer");
    // 截图之后用户可能已经又滚了：碰撞检测用"现在"屏幕上的位置
    const dy = anchor && strip ? anchor.scrollTop - strip.el.scrollTop + rectOf(strip.el).top - anchor.top : 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const [ymin, xmin, ymax, xmax] = it.box_2d.map((n) => Math.min(1000, Math.max(0, n)));
    // 稍微放大一点，盖住原文的边缘
    const rawW = ((xmax - xmin) / 1000) * vw;
    const rawH = ((ymax - ymin) / 1000) * vh;
    const grow = display.boxMode === "grow";
    // 竖排长条的横向位置最容易偏，撑大模式下左右多留一些余量
    const padX = grow && rawH > rawW * 1.6 ? Math.max(6, rawW * 0.2) : grow ? 6 : 3;
    const padY = grow ? 6 : 3;
    const minSide = grow ? 30 : 16;
    let width = Math.max(rawW + padX * 2, minSide);
    const height = Math.max(rawH + padY * 2, minSide);
    // 英文等拼音文字不能竖排，而且比中文长：竖长的框（原文是竖排）横向加宽，排成几行短句。
    // 不在单词中间断开：一个词放不下时由 fit() 把字缩小（overflowing 会检查横向溢出）
    const latin = !CJK.test(it.translation);
    const top = Math.max(0, Math.min(vh - height, (ymin / 1000) * vh + rawH / 2 - height / 2));
    const centerX = (xmin / 1000) * vw + rawW / 2;
    const leftFor = (w) => Math.max(0, Math.min(vw - w, centerX - w / 2));
    if (latin && height > width * 1.2) {
      // 字密的格子里加宽会盖到旁边的框：碰到已经画好的框就少加宽一点，放不下的由 fit() 缩小字号
      const base = width;
      const others = [...layer.querySelectorAll(".box"), ...(strip?.track.children || [])].map((b) => b.getBoundingClientRect());
      const hits = (w) =>
        others.some((r) => leftFor(w) < r.right && leftFor(w) + w > r.left && top + dy < r.bottom && top + dy + height > r.top);
      width = Math.max(base, Math.min(height * 0.8, vw * 0.22, rawW * 2));
      while (width > base && hits(width)) width = Math.max(base, width * 0.85);
    }
    const left = leftFor(width);
    const el = document.createElement("div");
    if (it.id) el.dataset.id = it.id;
    el.className =
      "box" + (latin ? " latin" : "") + (it.dark ? " dark" : "");
    el.setAttribute("translate", "no");
    el.classList.add("notranslate");
    // 框重叠时小的叠在上面，不会被大框整个盖住
    const z = Math.max(1, 1e6 - Math.round(width * height));
    // 条漫：换算成在整条上的位置（track 跟着滚动移动）
    const x = anchor ? left - anchor.left : left;
    const y = anchor ? top - anchor.top + anchor.scrollTop : top;
    el.style.cssText = `left:${x}px;top:${y}px;width:${width}px;height:${height}px;z-index:${z};`;
    el.textContent = it.translation;
    (anchor ? strip.track : layer).appendChild(el);
    fit(el);
    if (latin) {
      // 竖排原文的框很高，英文横排只要几行：去掉多余的高度，少挡画面（保持上下居中）
      const before = el.offsetHeight;
      el.style.height = "auto";
      const need = Math.max(el.offsetHeight, minSide);
      if (need < before) el.style.top = y + (before - need) / 2 + "px";
      el.style.height = Math.min(need, before) + "px";
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "ping") return reply("pong");
    if (msg.type === "geom") return reply(geom());
    if (msg.type === "waitLoaded") return siteLoaded().then((waited) => reply({ waited })), true;
    if (msg.type === "hide") return reply({ masks: hide(msg.y0, msg.y1, msg.hideUi), hidden: hidden.length });
    if (msg.type === "show") return show(), reply(true);
    if (msg.type === "scrollTo") return scrollStrip(msg.y, msg.quick).then(reply), true;
    if (msg.type === "prefetchState") prefetchState(msg);
    else if (msg.type === "stripClear") strip?.track.replaceChildren();
    else if (msg.type === "stripDrop") {
      // 重新翻译这一屏：先删掉这一段的旧译文
      for (const el of [...(strip?.track.children || [])]) {
        const c = parseFloat(el.style.top) + el.offsetHeight / 2;
        if (c >= msg.y0 && c <= msg.y1) el.remove();
      }
    } else if (msg.type === "stripBegin") {
      // 几段可能同时在翻：全部翻完才收起"翻译中"
      stripRuns++;
      clear(); // 之前翻页模式留下的框和提示
      if (fabState === "idle" || fabState === "done" || fabState === "stopped") toast(TRANSLATING);
    } else if (msg.type === "stripAdd") {
      if (!strip) return;
      // 换掉之前画的不完整的框
      if (msg.replace) strip.track.querySelector(`[data-id="${msg.replace}"]`)?.remove();
      addBox(msg.item, msg.anchor);
    } else if (msg.type === "stripDone") {
      stripRuns = Math.max(0, stripRuns - 1);
      if (stripRuns) return;
      ensureHost().querySelector(".toast")?.remove();
      // 自动翻的时候不弹提示（条漫里没字的空白段很多）
      if (!msg.auto && !msg.count) toast(zh ? "这一屏没有新的文字需要翻译。" : "No new text on this screen.", false, 2500);
      else if (!msg.auto) toast(zh ? `${msg.seconds.toFixed(1)} 秒 · ${msg.model}` : `${msg.seconds.toFixed(1)}s · ${msg.model}`, false, 3000);
    }
    else if (msg.type === "clear") clear();
    else if (msg.type === "stale") {
      // 后台发现画面变了（翻页了）：旧译文作废
      activeRun = null;
      inFlight = false;
      clear();
    }
    else if (msg.type === "begin") {
      resetStrip(); // 后台判断这不是条漫
      clear();
      activeRun = msg.runId;
      inFlight = !!msg.loading;
      if (msg.loading) toast(TRANSLATING);
    } else if (msg.runId && msg.runId !== activeRun) {
      return;
    } else if (msg.type === "loading") toast(msg.text || TRANSLATING);
    else if (msg.type === "add") {
      ensureHost().querySelector(".toast")?.remove();
      addBox(msg.item);
    } else if (msg.type === "done") {
      inFlight = false;
      (msg.items || []).forEach(addBox);
      const shown = ensureHost().querySelectorAll(".box").length;
      if (!shown) toast(zh ? "这个画面里没找到需要翻译的文字。" : "No text to translate on this screen.", false, 2500);
      else if (msg.seconds) {
        const first = msg.firstSeconds.toFixed(1);
        const all = msg.seconds.toFixed(1);
        toast(zh ? `首个译文 ${first} 秒 · 全部 ${all} 秒 · ${msg.model}` : `First ${first}s · all ${all}s · ${msg.model}`, false, 4000);
      }
    } else if (msg.type === "error") {
      inFlight = false;
      stripRuns = Math.max(0, stripRuns - 1);
      toast(msg.text, true, 6000);
    }
  });

  // 翻页、滚动、缩放窗口后，旧译文就对不上了：清掉、取消还没翻完的。
  // 自动翻译由后台每秒比对画面来触发（阅读器可能拦下点击和按键，光靠事件不可靠），
  // 这里只负责马上清掉旧译文，并告诉后台"画面可能变了"
  const onPageChange = () => {
    if (strip) return; // 条漫的译文跟着滚动走，不用清
    if (activeRun === null) return;
    if (inFlight) chrome.runtime.sendMessage({ type: "cancel" }).catch(() => {});
    activeRun = null;
    inFlight = false;
    clear();
    chrome.runtime.sendMessage({ type: "cleared" }).catch(() => {});
  };
  window.addEventListener("keydown", (e) => {
    // 带修饰键的多半是快捷键（包括本插件的 Option+T），不算翻页
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key !== "Shift") onPageChange();
  }, true);
  // 有的阅读器会拦掉 mousedown，所以 pointerdown / touchstart 也听
  for (const type of ["pointerdown", "mousedown", "touchstart"])
    window.addEventListener(type, onPageChange, { capture: true, passive: true });
  window.addEventListener("wheel", onPageChange, { capture: true, passive: true });
  // 条漫的排版只跟宽度有关：只有宽度或缩放比例变了才作废（下载栏弹出、工具栏收起只改高度，译文位置不受影响）
  let layoutKey = `${innerWidth}@${devicePixelRatio}`;
  const onLayout = (e) => {
    const key = `${innerWidth}@${devicePixelRatio}`;
    const widthChanged = key !== layoutKey;
    layoutKey = key;
    if (strip && e.type === "resize" && !widthChanged) return placeTrack();
    if (strip) {
      resetStrip();
      clear();
      chrome.runtime.sendMessage({ type: "cleared" }).catch(() => {});
    } else onPageChange();
  };
  window.addEventListener("resize", onLayout);
  document.addEventListener("fullscreenchange", onLayout);
}
