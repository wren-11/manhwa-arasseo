import { listModels, pickDefaultModel, translateScreenshot, FALLBACK_MODEL } from "./gemini.js";
import { translateWithClaude, CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS } from "./claude.js";
import { t } from "./i18n.js";
import { PROVIDERS, translateCompat } from "./compat.js";

const CACHE_LIMIT = 50;
// 截图在 Retina 屏上是 2 倍大小，缩到这个长边再发，上传和识别都更快
const MAX_SIDE = 1800;
// Claude 会把超过这个尺寸的图在内部缩小，坐标就对不上了；先自己缩到范围内
const CLAUDE_LIMITS = { maxSide: 1568, maxPixels: 1_150_000 };

// 每个标签页同时只跑一次翻译；新的一次开始就取消旧的，省钱
const running = new Map();

chrome.action.onClicked.addListener((tab) => run(tab));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === "translate") run(tab);
  else if (cmd === "prefetch") run(tab, { prefetch: true });
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  if (msg.type === "cancel") running.get(sender.tab.id)?.abort();
  else if (msg.type === "cleared") markCleared(sender.tab.id);
  else if (msg.type === "scrollIdle") {
    if (msg.scrollTop != null) stateOf(sender.tab.id).userTop = msg.scrollTop; // 用户看到哪了：预翻译先翻这附近
    onScrollIdle(sender.tab);
  }
  else if (msg.type === "prefetchToggle") run(sender.tab, { prefetch: true });
  else if (msg.type === "prefetchStop") {
    console.debug("[预翻译] 页面上有操作，停止：", msg.why);
    stopPrefetch(sender.tab.id);
  }
});

function ask(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => null);
}

function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
}

// 插件重新加载后，页面里留着的旧脚本已经失效：问不通就清掉重装，不用手动刷新页面
async function ensureContentScript(tabId) {
  const alive = await chrome.tabs
    .sendMessage(tabId, { type: "ping" }, { frameId: 0 })
    .catch(() => null);
  if (alive === "pong") return;
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      delete window.__manhwaTranslatorReady;
      document.querySelectorAll("[data-manhwa-translator], [data-manhwa-translator-strip]").forEach((el) => el.remove());
    },
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function getModel(apiKey, saved) {
  if (saved) return saved;
  let model = FALLBACK_MODEL;
  try {
    model = pickDefaultModel(await listModels(apiKey));
  } catch {}
  await chrome.storage.local.set({ model });
  return model;
}

async function run(tab, { auto = false, prefetch = false } = {}) {
  if (!tab?.id) return;
  if (!auto) {
    try {
      await ensureContentScript(tab.id);
    } catch {
      return; // chrome:// 之类的页面不能注入
    }
  }

  const {
    provider: savedProvider,
    apiKey: geminiKey,
    model: savedModel,
    claudeKey,
    claudeModel: savedClaudeModel,
    lang = "zh-Hans",
  } = await chrome.storage.local.get(["provider", "apiKey", "model", "claudeKey", "claudeModel", "lang"]);
  // 设置页现在只有通义千问和 Claude；以前存的 Gemini（代码还留着，以后可以加回来）也按设置页显示的默认值走
  const provider = savedProvider === "claude" || savedProvider === "qwen" ? savedProvider : "qwen";
  const claudeModel = CLAUDE_MODELS.some((m) => m.name === savedClaudeModel) ? savedClaudeModel : CLAUDE_DEFAULT_MODEL;
  const isClaude = provider === "claude";
  // 兼容接口的服务商（通义千问等）的 key 和模型存成 qwenKey / qwenModel 这样
  const compat = PROVIDERS[provider];
  const isGemini = !isClaude && !compat;
  const compatSaved = compat
    ? await chrome.storage.local.get([`${provider}Key`, `${provider}Model`, `${provider}Base`])
    : {};
  // 存的模型已经从列表里删掉了（比如以前选过的 qwen3-vl-flash），就用默认的
  const savedCompat = compatSaved[`${provider}Model`];
  const compatModel = compat && (compat.models.some((m) => m.name === savedCompat) ? savedCompat : compat.models[0].name);
  const apiKey = isClaude ? claudeKey : compat ? compatSaved[`${provider}Key`] : geminiKey;
  if (!apiKey) {
    const name = isClaude ? "Claude" : compat ? compat.name : "Gemini";
    await send(tab.id, { type: "error", text: t("noKey", { name }) });
    chrome.runtime.openOptionsPage();
    return;
  }
  const conf = { provider, isClaude, compat, compatSaved, compatModel, claudeModel, savedModel, apiKey, lang };

  // 条漫：一整话是一条很长的滚动页面。按在整条上的位置记住翻过哪些，只翻新露出来的部分
  const g = await ask(tab.id, { type: "geom" });
  if (g?.strip) {
    running.get(tab.id)?.abort();
    return prefetch ? togglePrefetch(tab, g, conf) : runStrip(tab, g, auto, conf);
  }
  const prev = sessions.get(tab.id);
  if (prev) prev.strip = null;

  running.get(tab.id)?.abort();
  const controller = new AbortController();
  running.set(tab.id, controller);
  const runId = `${Date.now()}-${Math.random()}`;

  // 先清掉旧译文和提示，再截图，不然会把它们也截进去
  await send(tab.id, { type: "clear" });
  await new Promise((r) => setTimeout(r, 80));

  let dataUrl;
  try {
    dataUrl = await capture(tab.windowId, 85);
  } catch (e) {
    // 自动模式下截图失败（比如切到了别的窗口）就安静地跳过
    if (!auto) await send(tab.id, { type: "error", text: t("captureFailed", { msg: e.message }) });
    if (running.get(tab.id) === controller) running.delete(tab.id);
    return;
  }
  const session = watch(tab);
  session.baseline = await signature(dataUrl);
  session.boxes = [];
  session.pending = false;

  // 缓存按模型分开：换了模型再翻同一页，要能看到新模型的结果
  const cacheModel = isClaude ? claudeModel : compat ? compatModel : savedModel || "auto";
  const tag = `${provider}:${cacheModel}:${lang}`;
  const cached = await lookup(tag, session.baseline);
  if (cached) {
    session.boxes = cached.map((it) => it.box_2d);
    await send(tab.id, { type: "begin", runId });
    await send(tab.id, { type: "done", runId, items: cached });
    if (running.get(tab.id) === controller) running.delete(tab.id);
    return;
  }

  await send(tab.id, { type: "begin", runId, loading: true });
  try {
    const started = Date.now();
    let first = 0;
    const { model, translate, allowSplit, limits } = await translator(tab.id, conf);
    const pieces = await splitScreenshot(dataUrl, { cols: allowSplit, rows: allowSplit && limits.rows === 2 }, limits);
    const shade = await shader(dataUrl);
    // 模型有时给同一段文字返回好几个框，叠在一起会互相挡住：和已画的框大面积重叠就不画
    const shown = [];
    await Promise.all(
      pieces.map((piece) =>
        translate({
          apiKey,
          model,
          lang,
          imageBase64: piece.base64,
          width: piece.width,
          height: piece.height,
          signal: controller.signal,
          onItem: (raw) => {
            const item = piece.toGlobal(raw);
            if (!item) return console.debug(`[${piece.name}] 中心点不在这一块，丢掉：`, raw.box_2d, raw.translation);
            if (shown.some((it) => overlaps(it.box_2d, item.box_2d)))
              return console.debug(`[${piece.name}] 和已画的框重叠，丢掉：`, item.box_2d, item.translation);
            shown.push(item);
            item.dark = shade(item.box_2d);
            first ||= Date.now();
            session.boxes.push(item.box_2d);
            send(tab.id, { type: "add", runId, item });
          },
        })
      )
    );
    const items = shown;
    await remember(tag, session.baseline, items);
    await send(tab.id, {
      type: "done",
      runId,
      count: items.length,
      firstSeconds: first ? (first - started) / 1000 : 0,
      model: model.replace("models/", ""),
      seconds: (Date.now() - started) / 1000,
    });
  } catch (e) {
    if (e.name !== "AbortError") await send(tab.id, { type: "error", runId, text: e.message });
  } finally {
    if (running.get(tab.id) === controller) running.delete(tab.id);
  }
}

async function translator(tabId, c) {
  const model = c.isClaude ? c.claudeModel : c.compat ? c.compatModel : await getModel(c.apiKey, c.savedModel);
  const translate = c.isClaude
    ? (opts) => translateWithClaude(opts)
    : c.compat
      ? (opts) => translateCompat({ ...opts, provider: c.provider, baseUrl: c.compatSaved[`${c.provider}Base`] })
      : (opts) => translateWithFallback(tabId, opts);
  // 切成几块同时请求：每块字少，回得快；总时间约等于最慢那一块
  // 免费 key 每分钟能发的次数很少；碰到过限速，这次会话里就不切块，一页只发一次
  const { noSplit = false } = await chrome.storage.session.get("noSplit");
  const allowSplit = c.isClaude || (c.compat ? c.compat.split : !noSplit);
  const limits = c.isClaude ? CLAUDE_LIMITS : c.compat?.image || {};
  return { model, translate, allowSplit, limits };
}

// ---------- 条漫 ----------
// 位置都用"整条上的 CSS 像素"（content 坐标）：y = 屏幕上的 y - 滚动框顶部 + 滚动距离。
// strip.ledger 记翻过的区间，strip.items 记画过的框（去重用），一话之内往回翻也不用重翻
const STRIP_MARGIN = 0.12;
let boxSeq = 0; // 往已翻区多截一段，跨在交界处的对话框才是完整的
// 截图一次只做一个（要藏译文、确认画面停稳）；翻译可以几段同时跑，滚得快也不用排队等前一段翻完
const STRIP_PAR = 3;
const stripState = new Map(); // tabId → { capturing, inflight, again, manual }

function union(ranges, [a, b]) {
  const out = [];
  for (const r of [...ranges, [a, b]].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

// [a, b] 里还没被 ranges 盖住的部分
function subtract([a, b], ranges) {
  let gaps = [[a, b]];
  for (const [c, d] of ranges)
    gaps = gaps.flatMap(([x, y]) =>
      d <= x || c >= y ? [[x, y]] : [...(c > x ? [[x, c]] : []), ...(d < y ? [[d, y]] : [])]
    );
  return gaps;
}

async function onScrollIdle(tab) {
  const s = sessions.get(tab?.id);
  // 只在这个标签页已经开始翻条漫后才自动翻，别的网站滚动不会花钱
  if (!s?.strip && !s?.stripAuto) return;
  if (stripState.get(tab.id)?.prefetch) return; // 预翻译自己在滚，不用另外触发
  const { autoTranslate = true } = await chrome.storage.local.get("autoTranslate");
  if (autoTranslate) run(tab, { auto: true });
}

function stateOf(tabId) {
  let st = stripState.get(tabId);
  if (!st) stripState.set(tabId, (st = { capturing: false, inflight: 0, again: false, manual: false, prefetch: null }));
  return st;
}

async function runStrip(tab, g, auto, conf) {
  const st = stateOf(tab.id);
  if (st.prefetch) return; // 预翻译时不插队
  if (st.capturing || st.inflight >= STRIP_PAR) {
    // 忙着：记下来，手上的截完或翻完再按最新的位置补一次
    st.again = true;
    st.manual ||= !auto;
    return;
  }
  st.capturing = true;
  let job = null;
  try {
    job = await stripOnce(tab, g, auto, conf);
  } catch (e) {
    if (e.name !== "AbortError") await send(tab.id, { type: "error", text: e.message });
  } finally {
    st.capturing = false;
  }
  const retry = () => {
    if (!st.again || st.capturing || st.inflight >= STRIP_PAR) return;
    const manual = st.manual;
    st.again = st.manual = false;
    run(tab, { auto: !manual });
  };
  if (typeof job === "function") {
    st.inflight++;
    job()
      .catch(async (e) => {
        if (e.name !== "AbortError") await send(tab.id, { type: "error", text: e.message });
      })
      .finally(() => {
        st.inflight--;
        retry();
      });
  }
  retry();
}

// ---------- 标签页录制 ----------
// Chrome 截图每秒最多 2 张；录制标签页没有这个限制，预翻译快速滑过整话时用它取画面。
// 必须由用户按快捷键或点工具栏图标启动（Chrome 的规定），不行就退回截图
async function startRecorder(tab, g) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "录制当前标签页，快速取得条漫画面",
    });
  }
  const dpr = g.dpr || 1;
  const r = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start",
    streamId,
    width: Math.round(g.vw * dpr),
    height: Math.round(g.vh * dpr),
  });
  if (!r || r.error) throw new Error(r?.error || "录制没有启动");
  // 开始前先和真正的截图比一下：尺寸不同（被缩放、加了黑边）或画面对不上，就不用录制，免得坐标错位、翻错屏
  try {
    const f = await chrome.runtime.sendMessage({ target: "offscreen", type: "grab" });
    if (!f?.dataUrl) throw new Error(f?.error || "取不到画面");
    const shot = await capture(tab.windowId, 85);
    const [a, b] = await Promise.all([f.dataUrl, shot].map(async (u) => createImageBitmap(await (await fetch(u)).blob())));
    const d = diff(await signature(f.dataUrl), await signature(shot), maskFor([]));
    console.debug(`[预翻译] 录制画面 ${a.width}×${a.height}，截图 ${b.width}×${b.height}，两者差别 ${(d * 100).toFixed(1)}%`);
    if (Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) throw new Error(`录制画面尺寸 ${a.width}×${a.height} 和截图 ${b.width}×${b.height} 不一样`);
    if (d > 0.08) throw new Error(`录制画面和截图对不上（差别 ${(d * 100).toFixed(0)}%）`);
  } catch (e) {
    await stopRecorder();
    throw e;
  }
  // 取帧出错或明显变慢（比截图还慢），这一轮剩下的改用截图，不让整个预翻译卡住
  let slow = 0;
  const grab = async () => {
    if (grab.off) return capture(tab.windowId, 85);
    const t0 = Date.now();
    try {
      const f = await chrome.runtime.sendMessage({ target: "offscreen", type: "grab" });
      if (f?.stale) {
        // 看不出画面变没变：这一屏用截图，保证拿到的是滚动之后的样子
        console.debug(`[预翻译]   ${f.info}，这屏改用截图`);
        return capture(tab.windowId, 85);
      }
      if (!f?.dataUrl) throw new Error(f?.error || "取画面失败");
      const ms = Date.now() - t0;
      console.debug(`[预翻译]   取帧 ${ms} 毫秒：${f.info}`);
      if (ms > 1200 && ++slow >= 3) {
        grab.off = `取帧太慢（${ms} 毫秒）`;
        console.debug("[预翻译] 录制取帧太慢，改用截图");
      }
      return f.dataUrl;
    } catch (e) {
      grab.off = e.message || String(e);
      console.debug("[预翻译] 录制取帧失败，改用截图：", grab.off);
      return capture(tab.windowId, 85);
    }
  };
  return grab;
}

async function stopRecorder() {
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
    await chrome.offscreen.closeDocument();
  } catch {}
}

// ---------- 整话预翻译 ----------
// 从当前位置往下一屏一屏滚到底，每屏截图后交给后台翻译（几段同时翻），滚完回到原来的位置。
// 已经翻过的段会跳过；限速或出错没翻成的段留着，之后正常往下看时会自动补上
const PREFETCH_PAR = 4;

function stopPrefetch(tabId) {
  const job = stripState.get(tabId)?.prefetch;
  if (job) job.stop = true;
}

// 滚动截图和翻译分开：截好的屏放进队列，最多 PREFETCH_PAR 段同时翻；滚动不用等翻译，一口气截完
async function togglePrefetch(tab, g, conf) {
  const st = stateOf(tab.id);
  if (st.prefetch) return console.debug("[预翻译] 又按了一次，停止"), stopPrefetch(tab.id); // 再按一次就停
  const job = { stop: false, error: null };
  st.prefetch = job;
  const origin = g.scrollTop; // 扫完回到这里
  st.userTop = origin;
  const H0 = g.rect.bottom - g.rect.top;
  let scanPct = 0;
  let total = 0; // 截下来要翻的屏数
  let done = 0;
  let phase = "running";
  let stoppedByUser = false;
  let fast = false;
  // 截完之后又开了新的一轮：旧的这轮只管在后台翻完，不再改按钮
  const status = () =>
    (!st.prefetch || st.prefetch === job) &&
    send(tab.id, { type: "prefetchState", state: phase, pct: scanPct, done, total, stopped: stoppedByUser, fast });

  // 翻译队列：先翻用户正在看的位置往下最近的那段，翻译走在用户前面
  const queue = [];
  let active = 0;
  let pause = 0;
  let drained = null;
  const next = () => {
    const at = (st.userTop ?? origin) - H0 * 0.5;
    let best = -1;
    for (let i = 0; i < queue.length; i++) {
      const y = queue[i].band?.[0] ?? 0;
      const b = best < 0 ? null : queue[best].band?.[0] ?? 0;
      const ahead = y >= at;
      const bestAhead = b !== null && b >= at;
      // 在用户前面的优先、越近越先；都在后面的（已经看过去了）按从上到下
      if (best < 0 || (ahead && (!bestAhead || y < b)) || (!ahead && !bestAhead && y < b)) best = i;
    }
    return queue.splice(best, 1)[0];
  };
  const pump = () => {
    while (active < PREFETCH_PAR && queue.length && !job.error) {
      const task = next();
      active++;
      st.inflight++;
      (async () => {
        const wait = pause - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          await task();
          done++;
        } catch (e) {
          if (e.status === 429 && !task.retried) {
            // 限速：大家歇 20 秒，这一段放回队列再试一次
            pause = Date.now() + 20_000;
            task.retried = true;
            queue.push(task);
          } else if (e.name !== "AbortError") job.error ||= e;
          else done++;
        } finally {
          active--;
          st.inflight--;
          if (phase !== "running") status();
          pump();
          if (!active && (!queue.length || job.error)) drained?.();
        }
      })();
    }
  };

  let returnToOrigin = true;
  let grab = null;
  try {
    while (st.capturing) await sleep(100); // 等正在截的那次做完
    // 能录制就用录制（快），不行就退回截图（每秒最多 2 张）
    try {
      grab = await startRecorder(tab, g);
      fast = true;
    } catch (e) {
      console.debug("[预翻译] 不能录制，改用截图：", e.message);
    }
    status();
    const t0 = Date.now();
    // 从这一话开头滑到底
    let y = 0;
    let at = origin; // 现在滚到的位置
    while (!job.stop && !job.error) {
      // 录制：先记下滚动前的画面，取帧时要等到画面变了（位置没变就不用等）
      if (grab && Math.abs(y - at) > 2) await chrome.runtime.sendMessage({ target: "offscreen", type: "mark" }).catch(() => {});
      const now = await ask(tab.id, { type: "scrollTo", y });
      if (!now?.strip || job.stop) break;
      if (!now.visible || !(await isActive(tab))) {
        // 切到别的标签页了：暂停；切回来自动接着从这里截
        phase = "paused";
        status();
        while (!job.stop) {
          await sleep(800);
          const v = await ask(tab.id, { type: "geom" });
          if (!v?.strip) break;
          if (v.visible && (await isActive(tab))) break;
        }
        phase = "running";
        status();
        continue;
      }
      at = now.scrollTop;
      const H = now.rect.bottom - now.rect.top;
      const capStart = Date.now();
      scanPct = Math.min(99, Math.round(((now.scrollTop + H) / Math.max(1, now.scrollHeight)) * 100));
      status();
      const prevStrip = sessions.get(tab.id)?.strip;
      if (prevStrip) prevStrip.lastSeen = null; // 这一屏没截（都翻过了）时别拿上一屏的
      st.capturing = true;
      let translate = null;
      try {
        translate = await stripOnce(tab, now, true, conf, { prefetch: true, grab });
      } finally {
        st.capturing = false;
      }
      console.debug(
        `[预翻译] 第 ${total + 1} 屏：等图片 ${(now.waited / 1000).toFixed(1)} 秒，${fast && !grab?.off ? "录制取帧" : "截图"} ${((Date.now() - capStart) / 1000).toFixed(1)} 秒` +
          (now.solid || (grab && !grab.off) ? "（一张）" : "（两张比对）") +
          (typeof translate === "function" ? "" : translate === "hidden" ? "，切走了重来" : "，这屏跳过（空白、已翻过或画面在动）")
      );
      if (translate === "hidden") continue; // 截图那一下切走了：同一个位置再来
      if (typeof translate === "function") {
        total++;
        queue.push(translate);
        pump();
      }
      if (now.scrollTop + H >= now.scrollHeight - 2) break; // 到底了
      // 往下跳多少：按这一屏真正看得到的部分（去掉上面工具栏、下面按钮挡住的），再往回留 35% 屏高。
      // 被下边切开的对话框在下一屏要能整个露出来：重叠太少（以前 15%）的话，高一点的对话框两屏都只看到一半，就漏了。
      // 录制取画面很快，多扫几屏花不了多少时间；重叠部分画出的重复框会自动去掉
      const seen = sessions.get(tab.id)?.strip?.lastSeen;
      const topBlock = seen ? seen.top : 0;
      const seenEnd = seen && seen.end > now.scrollTop ? seen.end : now.scrollTop + H;
      y = Math.max(now.scrollTop + H * 0.3, Math.min(now.scrollTop + H * 0.65, seenEnd - topBlock - H * 0.35));
    }
    console.debug(`[预翻译] 扫完 ${total} 屏，用了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒（${fast ? (grab?.off ? "录制中途改截图：" + grab.off : "录制") : "截图"}）`);
    if (grab) await stopRecorder();
    grab = null;
    // 用户自己滚动或按键停下的，不要把他拉回去；被切开、被挡住的少数对话框，看到那里时边看边翻会补上
    returnToOrigin = !job.stop;
    stoppedByUser = job.stop;
    if (returnToOrigin) await ask(tab.id, { type: "scrollTo", y: origin, quick: true });
    // 扫完了：让出按钮。后台接着翻，用户可以正常看、正常边看边翻，也可以再点开始新的一轮
    st.prefetch = null;
    if (active || queue.length) {
      phase = "translating";
      status();
      await new Promise((r) => (drained = r));
    }
  } finally {
    if (grab) await stopRecorder();
    if (st.prefetch === job) st.prefetch = null;
    phase = job.error ? "idle" : !returnToOrigin ? "stopped" : "done";
    status();
    if (job.error) await send(tab.id, { type: "error", text: job.error.message });
  }
}

// 截图里这一段是不是"什么都没有"：和正上方像素差很多的点不到 12 个。
// 只看上下方向的变化：漫画两边的背景和白底之间那条竖线上下不变，不算内容；字的笔画上下都有变化，一个小小的"응"也算。
// 图不能缩太小、按点数而不是比例算：宁可多发一次也不能漏字
async function blankBand(dataUrl, R, covers, g) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const W = Math.min(480, Math.round((R.x1 - R.x0) * bmp.width));
  const H = Math.max(8, Math.round((W * ((R.y1 - R.y0) * bmp.height)) / ((R.x1 - R.x0) * bmp.width)));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, R.x0 * bmp.width, R.y0 * bmp.height, (R.x1 - R.x0) * bmp.width, (R.y1 - R.y0) * bmp.height, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  // 插件自己的按钮、提示不算
  const skip = (x, y) =>
    covers.some((m) => {
      const vx = (R.x0 + (x / W) * (R.x1 - R.x0)) * g.vw;
      const vy = (R.y0 + (y / H) * (R.y1 - R.y0)) * g.vh;
      return vx >= m.left - 2 && vx <= m.right + 2 && vy >= m.top - 2 && vy <= m.bottom + 2;
    });
  const gray = (x, y) => {
    const i = (y * W + x) * 4;
    return (px[i] + px[i + 1] + px[i + 2]) / 3;
  };
  let off = 0;
  for (let y = 1; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (Math.abs(gray(x, y) - gray(x, y - 1)) <= 40 || skip(x, y) || skip(x, y - 1)) continue;
      if (++off >= 12) return false;
    }
  return true;
}

async function isActive(tab) {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
  return active?.id === tab.id;
}

async function stripOnce(tab, g, auto, conf, opts = {}) {
  const t0 = Date.now();
  if (g.visible === false) return "hidden";
  const s = watch(tab);
  s.stripAuto = true;
  // 换了一话（网址变了）或者页面换了滚动框：从头记
  if (!s.strip || s.strip.href !== g.href || g.fresh) {
    if (s.strip) await send(tab.id, { type: "stripClear" });
    s.strip = { href: g.href, ledger: [], items: [] };
  }
  const strip = s.strip;
  strip.pending ||= []; // 正在翻的区间，别的段不要重复截
  const H = g.rect.bottom - g.rect.top;
  const vis = [g.scrollTop, g.scrollTop + H];
  strip.unseen ||= []; // 永远看不到的：滚到最底（最顶）了还被按钮、工具栏挡着的那一小条
  let gaps = subtract(vis, strip.ledger.concat(strip.pending, strip.unseen)).filter(([a, b]) => b - a > 4);
  const need = gaps.reduce((n, [a, b]) => n + b - a, 0);
  if (!auto && need < H * 0.1) {
    // 这一屏都翻过了还按快捷键：当作"重新翻译这一屏"
    strip.ledger = strip.ledger.flatMap((r) => subtract(r, [vis]));
    strip.items = strip.items.filter((b) => (b[0] + b[2]) / 2 < vis[0] || (b[0] + b[2]) / 2 > vis[1]);
    await send(tab.id, { type: "stripDrop", y0: vis[0], y1: vis[1] });
    gaps = [vis];
  } else if (need < Math.max(40, H * 0.08)) return; // 新露出来的太少，等再往下滚一点

  const band0 = Math.max(vis[0], gaps[0][0] - H * STRIP_MARGIN);
  const band1 = Math.min(vis[1], gaps[gaps.length - 1][1] + H * STRIP_MARGIN);
  const vy = (c) => c - g.scrollTop + g.rect.top; // content → 屏幕 CSS 像素
  // 只发漫画那一栏（两边各多留 8px）：两边的大片空白也发的话，整张图要缩得更小才符合模型的尺寸上限，字就小得认不出了
  const colX = g.col || g.rect;
  const region = {
    x0: Math.max(g.rect.left, colX.left - 8) / g.vw,
    x1: Math.min(g.rect.right, colX.right + 8) / g.vw,
    y0: vy(band0) / g.vh,
    y1: vy(band1) / g.vh,
  };

  // 截图前把这一段里已经画好的译文藏起来，不然会被截进去；截两次画面一样才算稳了
  // （图片还在加载、滚动动画没停，都会让两次不一样）
  // 预翻译时如果这一屏都是加载好的图片（g.solid），截一张就够了
  const hid = await ask(tab.id, { type: "hide", y0: vy(band0), y1: vy(band1), hideUi: !opts.prefetch });
  const covers = hid?.masks || [];
  // 录制取帧本身就等到画面不再变化才取，不用再截两张比对
  const once = !!(opts.prefetch && (g.solid || (opts.grab && !opts.grab.off)));
  let dataUrl = null;
  try {
    let prevSig = null;
    let loadingRetries = 0;
    for (let i = 0; i < 4 && !dataUrl; i++) {
      // 藏了译文要等它从屏幕上消失（一两帧）
      await sleep(i ? (opts.grab ? 150 : 300) : hid?.hidden ? 50 : 0);
      const shot = opts.grab ? await opts.grab() : await capture(tab.windowId, 85);
      const now = await ask(tab.id, { type: "geom" });
      if (!now?.strip || Math.abs(now.scrollTop - g.scrollTop) > 2) return; // 又滚了：等下一次停下
      if (!now.visible || !(await isActive(tab))) return "hidden"; // 截图时切到了别的标签页，截到的不是漫画
      if (now.loading && loadingRetries++ < 3) {
        // 截完才看到网站的「正在加载」提示（提示常常晚一点才弹出来）：这张多半是空白，等加载完再截
        console.debug("[条漫] 截图时网站还在加载，等它加载完再截");
        await ask(tab.id, { type: "waitLoaded" });
        prevSig = null;
        i = -1; // 重新开始数
        continue;
      }
      if (once) {
        dataUrl = shot;
        break;
      }
      const sig = await signature(shot);
      if (prevSig && diff(sig, prevSig, maskFor([])) < SETTLED) dataUrl = shot;
      prevSig = sig;
    }
  } catch (e) {
    if (!auto) await send(tab.id, { type: "error", text: t("captureFailed", { msg: e.message }) });
    return;
  } finally {
    await ask(tab.id, { type: "show" });
  }
  if (!dataUrl) return; // 画面一直在动（动图、广告），这次先不翻
  // 遮挡在截图那一刻就知道：被挡住的那一条不登记成"正在翻"，别的地方（比如补漏）要能马上去补
  // 被插件自己的按钮、提示挡住的那一条模型看不到：这次不算翻过，等滚到露出来再翻。
  // 在下半屏的（右下角按钮）挡住下边，在上半屏的（右上角提示）挡住上边
  const col = g.col || g.rect;
  const blocked = covers.concat(g.overlays || []).filter((m) => m.right > col.left && m.left < col.right && m.bottom > vy(band0) && m.top < vy(band1));
  const isLower = (m) => (m.top + m.bottom) / 2 > (vy(band0) + vy(band1)) / 2;
  let lo0 = band0;
  let hi0 = band1;
  for (const m of blocked) {
    if (isLower(m)) hi0 = Math.min(hi0, m.top - g.rect.top + g.scrollTop);
    else lo0 = Math.max(lo0, m.bottom - g.rect.top + g.scrollTop);
  }
  // 留 12px 余量：模型给的框常常停在遮挡物边上（只框了看得到的那一半）
  // 返回挡住它的那个东西（没有就是 undefined）
  // 这一屏真正看得到的范围：顶上被工具栏挡了多少（屏幕像素），底下看到哪（整条上的位置）
  let topBlock = 0;
  for (const m of blocked) if (!isLower(m)) topBlock = Math.max(topBlock, m.bottom - g.rect.top);
  strip.lastSeen = { top: topBlock, end: hi0 };
  const underCover = (box) => {
    const [y0, x0, y1, x1] = box.map((v, i) => (v / 1000) * (i % 2 ? g.vw : g.vh));
    return blocked.find((m) => x1 > m.left - 12 && x0 < m.right + 12 && y1 > m.top - 12 && y0 < m.bottom + 12);
  };
  // 整段都是空白（条漫格子之间的大片白底、黑底）：不用发给模型，直接记成翻过了
  if (await blankBand(dataUrl, region, covers.concat(g.overlays || []), g)) {
    // 预翻译时不记：网站可能还没加载出来（截到的是空白），等用户看到这里、边看边翻时再确认一次（只在本地判断，不花钱）
    if (hi0 > lo0 && !opts.prefetch) strip.ledger = union(strip.ledger, [lo0, hi0]); // 被挡住的那条不算
    console.debug(`[条漫] ${Math.round(band1 - band0)}px 是空白，跳过`);
    return () => Promise.resolve();
  }
  if (band1 >= g.scrollHeight - 1 && hi0 < band1) strip.unseen = union(strip.unseen, [hi0, band1]);
  if (band0 <= 1 && lo0 > band0) strip.unseen = union(strip.unseen, [band0, lo0]);
  const mine = [lo0, hi0];
  if (hi0 > lo0) strip.pending.push(mine);
  const captured = Date.now();
  const job = () => translateBand().finally(() => (strip.pending = strip.pending.filter((r) => r !== mine)));
  job.band = [band0, band1]; // 预翻译排队时按位置排先后
  return job;

  async function translateBand() {

  const { model, translate, allowSplit, limits } = await translator(tab.id, conf);
  const bandW = region.x1 - region.x0;
  const bandH = (band1 - band0) / g.vh;
  // 条漫的格子横跨整个宽度，不左右切；只在很高的一段上下切
  // 一段比较高就上下切成两块同时发：每块要找的框少一半，回得快（交界多重叠一些，免得切断对话框）
  // 预翻译时不切：几屏本来就同时在翻，切了请求数翻倍，更容易撞上限速
  const masks = covers.map((m) => ({ x0: m.left / g.vw, x1: m.right / g.vw, y0: m.top / g.vh, y1: m.bottom / g.vh }));
  const pieces = await splitScreenshot(dataUrl, { cols: false, rows: !opts.prefetch && allowSplit && bandH * g.vh > 480, overlapY: 0.15, masks }, limits, region);
  const shade = await shader(dataUrl);
  const toC = (y) => (y / 1000) * g.vh - g.rect.top + g.scrollTop;
  const bh = band1 - band0;
  const EDGE = Math.max(6, bh * 0.015);
  const atTop = band0 <= 1;
  const atBottom = band1 >= g.scrollHeight - 1;
  let lo = lo0;
  let hi = hi0;
  let count = 0;
  const started = Date.now();
  await send(tab.id, { type: "stripBegin" });
  await Promise.all(
    pieces.map((piece) =>
      translate({
        apiKey: conf.apiKey,
        model,
        lang: conf.lang,
        imageBase64: piece.base64,
        width: piece.width,
        height: piece.height,
        onItem: (raw) => {
          if (s.strip !== strip) return; // 翻的时候换了一话
          const item = piece.toGlobal(raw);
          if (!item) return;
          const c0 = toC(item.box_2d[0]);
          const c1 = toC(item.box_2d[2]);
          // 贴着截图上下边缘的框多半被切掉了一半：先不画，这一段也不算翻过，等它整个露出来再翻
          const tall = c1 - c0 > bh * 0.6;
          const why = (r) => console.debug(`[条漫] 丢掉 ${Math.round(c0)}–${Math.round(c1)}（段 ${Math.round(band0)}–${Math.round(band1)}）：${r}`);
          if (!tall && !atTop && c0 - band0 < EDGE) return void ((lo = Math.max(lo, c1)), why("贴着上边"));
          if (!tall && !atBottom && band1 - c1 < EDGE) return void ((hi = Math.min(hi, c0)), why("贴着下边"));
          const cover = underCover(item.box_2d);
          // 可能只看到一半，等露出来再翻：挡在下面的从下边收，挡在上面的从上边收
          if (cover) return void (isLower(cover) ? (hi = Math.min(hi, c0)) : (lo = Math.max(lo, c1)), why("被挡住"));
          const cbox = [c0, item.box_2d[1], c1, item.box_2d[3]];
          cbox.id = `b${++boxSeq}`;
          // 和已经画过的框是同一处：新的明显更完整（比如上次只看到半个对话框）就换掉旧的，否则丢掉新的
          const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
          const old = strip.items.find((b) => overlaps(b, cbox));
          if (old && area(cbox) <= area(old) * 1.25) return void why("重复");
          if (old) strip.items.splice(strip.items.indexOf(old), 1), why("比之前画的完整，换掉旧的");
          strip.items.push(cbox);
          item.id = cbox.id;
          item.dark = shade(item.box_2d);
          count++;
          send(tab.id, { type: "stripAdd", item, replace: old?.id, anchor: { scrollTop: g.scrollTop, top: g.rect.top, left: g.rect.left } });
        },
      })
    )
  );
  console.debug(
    `[条漫] ${Math.round(band1 - band0)}px 分 ${pieces.length} 块：截图 ${((captured - t0) / 1000).toFixed(1)} 秒，` +
      `翻译 ${((Date.now() - started) / 1000).toFixed(1)} 秒，${count} 个框`
  );
  // 一个字都没找到：把发给模型的图打在日志里（详细级别），能直接看到模型看到的是什么
  if (!count)
    for (const piece of pieces)
      console.debug(
        `[条漫图] 段 ${Math.round(band0)}–${Math.round(band1)} 没找到字，模型看到的是：%c `,
        `font-size:1px;padding:${Math.round(160 * Math.min(2, piece.height / piece.width))}px 160px;background:url(data:image/jpeg;base64,${piece.base64}) no-repeat center/contain`
      );
  await send(tab.id, { type: "stripDone", auto, count, model: model.replace("models/", ""), seconds: (Date.now() - started) / 1000 });
  if (s.strip !== strip) return;
  if (hi > lo) strip.ledger = union(strip.ledger, [lo, hi]);
  console.debug(`[条漫] 段 ${Math.round(band0)}–${Math.round(band1)} 记为翻过 ${Math.round(lo)}–${Math.round(hi)}，画了 ${count} 个`);
  }
}

// 交叠部分占较小那个框的六成以上，就算是同一段文字
function overlaps([ay0, ax0, ay1, ax1], [by0, bx0, by1, bx1]) {
  const w = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  const h = Math.min(ay1, by1) - Math.max(ay0, by0);
  if (w <= 0 || h <= 0) return false;
  const smaller = Math.min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0));
  return smaller > 0 && (w * h) / smaller > 0.6;
}

// 看原文那块区域整体是深色还是浅色
async function shader(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(8, 8);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return ([ymin, xmin, ymax, xmax]) => {
    const sx = (xmin / 1000) * bmp.width;
    const sy = (ymin / 1000) * bmp.height;
    const sw = Math.max(1, ((xmax - xmin) / 1000) * bmp.width);
    const sh = Math.max(1, ((ymax - ymin) / 1000) * bmp.height);
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, 8, 8);
    const px = ctx.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return sum / 64 < 110;
  };
}

// ---------- 翻页检测 ----------
// 阅读器可能拦下点击和按键，所以不靠事件：每秒截一张小图和翻译时的画面比，
// 译文框盖住的地方和右上角的提示不算。画面变了 = 翻页了；等画面停稳再自动翻译。
const WATCH_MS = 1000;
const GRID_W = 32;
const GRID_H = 24;
const CELL_DIFF = 30; // 一个格子灰度差超过这个算"变了"（0–255）
const PAGE_TURN = 0.3; // 超过三成的格子变了才算翻页（鼠标晃出工具栏只会变一小块）
const SETTLED = 0.03; // 连续两次变化不到 3%，算停稳了
const SAME_PAGE = 0.15; // 查缓存时，变化不到 15% 就当作同一页（真翻页通常七成以上都变了）
const sessions = new Map();
let watchTimer = null;
let ticking = false;

function watch(tab) {
  let s = sessions.get(tab.id);
  if (!s) {
    s = { tab, baseline: null, boxes: [], pending: false, lastSig: null };
    sessions.set(tab.id, s);
  }
  s.tab = tab;
  watchTimer ??= setInterval(tick, WATCH_MS);
  return s;
}

function unwatch(tabId) {
  sessions.delete(tabId);
  if (!sessions.size && watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}
chrome.tabs.onRemoved.addListener(unwatch);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // 真正打开了新页面才停（阅读器翻页时可能只改网址里的页码，那种不算）
  if (info.status === "loading") unwatch(tabId);
  // 网址变了但页面没重新加载（条漫网站在页面里直接切到下一话）：清掉上一话的译文
  else if (info.url && sessions.get(tabId)?.strip && info.url.split("#")[0] !== sessions.get(tabId).strip.href) {
    sessions.get(tabId).strip = null;
    send(tabId, { type: "stripClear" });
  }
});

function markCleared(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.boxes = [];
  s.pending = true;
  s.lastSig = null;
  s.strip = null; // 窗口大小变了，条漫上记的位置都不准了
}

// 截图每秒最多两次，撞上限就等一下再试
// Chrome 每秒最多截 2 张：自己排好节奏，不要等撞上限报错再多等
const shots = [];
async function capture(windowId, quality) {
  const wait = shots.length >= 2 ? shots[shots.length - 2] + 1020 - Date.now() : 0;
  if (wait > 0) await sleep(wait);
  shots.push(Date.now());
  if (shots.length > 4) shots.shift();
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality });
  } catch (e) {
    if (!/MAX_CAPTURE/i.test(e.message)) throw e;
    await sleep(600);
    return chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality });
  }
}

async function signature(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(GRID_W, GRID_H);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, GRID_W, GRID_H);
  const px = ctx.getImageData(0, 0, GRID_W, GRID_H).data;
  const sig = new Float32Array(GRID_W * GRID_H);
  for (let i = 0; i < sig.length; i++) sig[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  return sig;
}

function maskFor(boxes) {
  const mask = new Uint8Array(GRID_W * GRID_H);
  const cover = (y0, x0, y1, x1) => {
    const cx0 = Math.max(0, Math.floor(x0 * GRID_W) - 1);
    const cx1 = Math.min(GRID_W - 1, Math.ceil(x1 * GRID_W));
    const cy0 = Math.max(0, Math.floor(y0 * GRID_H) - 1);
    const cy1 = Math.min(GRID_H - 1, Math.ceil(y1 * GRID_H));
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) mask[y * GRID_W + x] = 1;
  };
  for (const [ymin, xmin, ymax, xmax] of boxes) cover(ymin / 1000, xmin / 1000, ymax / 1000, xmax / 1000);
  cover(0, 0.75, 0.15, 1); // 右上角的提示条
  cover(0, 0, 0.1, 1); // 顶部和底部：阅读器的工具栏、页码条常在这里，鼠标一动就会出现
  cover(0.9, 0, 1, 1);
  return mask;
}

// 返回没被遮住的格子里，明显变了的比例（0–1）
function diff(a, b, mask) {
  let changed = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask[i]) continue;
    if (Math.abs(a[i] - b[i]) > CELL_DIFF) changed++;
    n++;
  }
  return n ? changed / n : 0;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const s of sessions.values()) await checkTab(s);
  } finally {
    ticking = false;
  }
}

async function checkTab(s) {
  if (s.strip) return; // 条漫靠页面里的滚动事件触发
  const { id: tabId, windowId } = s.tab;
  if (running.has(tabId)) return; // 正在翻译，基准画面由翻译那边负责
  let dataUrl;
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active?.id !== tabId) return; // 只看用户正在看的那个标签页
    dataUrl = await capture(windowId, 40);
  } catch {
    return;
  }
  if (running.has(tabId)) return;
  const sig = await signature(dataUrl);

  if (!s.pending) {
    if (!s.baseline) s.baseline = sig;
    else if (diff(sig, s.baseline, maskFor(s.boxes)) > PAGE_TURN) {
      // 翻页了：清掉旧译文，等画面停稳
      s.pending = true;
      s.boxes = [];
      s.lastSig = sig;
      send(tabId, { type: "stale" });
    }
    return;
  }

  // 等待中：和上一秒几乎一样，说明翻页动画结束了
  const settled = s.lastSig && diff(sig, s.lastSig, maskFor([])) < SETTLED;
  s.lastSig = sig;
  if (!settled) return;
  s.pending = false;
  const { autoTranslate = true } = await chrome.storage.local.get("autoTranslate");
  if (autoTranslate) run(s.tab, { auto: true });
  else s.baseline = sig;
}

// 横向的画面（比如左右两页的跨页）切成左右两块，中间重叠一段，免得切断对话框；
// 每个框只归中心点所在的那一块，重叠区里的框不会出现两次。
// limits.rows = 2 时每半再上下切开：小模型在字很密的格子里容易漏看，切小了字更大、要找的框更少
const OVERLAP = 0.06;
const OVERLAP_Y = 0.1; // 竖排对话框很长，上下切要多重叠一些

function bands(n, overlap) {
  if (n === 1) return [{ a: 0, b: 1, own: [0, 1] }];
  return [
    { a: 0, b: 0.5 + overlap, own: [0, 0.5] },
    { a: 0.5 - overlap, b: 1, own: [0.5, 1] },
  ];
}

// R：只用截图里的这一块（0–1 比例），返回的框还是按整张截图算
const FULL = { x0: 0, x1: 1, y0: 0, y1: 1 };

async function splitScreenshot(dataUrl, split, limits, R = FULL) {
  let bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  if (split.masks?.length) {
    // 插件自己的按钮和提示：涂白，免得被当成漫画里的字
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    ctx.fillStyle = "#fff";
    for (const m of split.masks) ctx.fillRect(m.x0 * bmp.width, m.y0 * bmp.height, (m.x1 - m.x0) * bmp.width, (m.y1 - m.y0) * bmp.height);
    bmp = canvas;
  }
  const RW = R.x1 - R.x0;
  const RH = R.y1 - R.y0;
  const W = bmp.width * RW;
  const H = bmp.height * RH;
  const wide = split.cols && W > H * 1.2;
  const cols = bands(wide ? 2 : 1, OVERLAP);
  const rows = bands(split.rows ? 2 : 1, split.overlapY ?? OVERLAP_Y);
  const regions = rows.flatMap((r, ri) =>
    cols.map((c, ci) => ({
      name: (rows.length > 1 ? ["上", "下"][ri] : "") + (cols.length > 1 ? ["左", "右"][ci] : "") || "整页",
      x0: c.a, x1: c.b, ownX: c.own,
      y0: r.a, y1: r.b, ownY: r.own,
    }))
  );
  return Promise.all(
    regions.map(async ({ name, x0, x1, ownX, y0, y1, ownY }) => {
      const sx = Math.round((R.x0 + x0 * RW) * bmp.width);
      const sw = Math.round((x1 - x0) * W);
      const sy = Math.round((R.y0 + y0 * RH) * bmp.height);
      const sh = Math.round((y1 - y0) * H);
      const { base64, width, height } = await encode(bmp, sx, sw, sy, sh, limits);
      const toGlobal = (it) => {
        const [ymin, xmin, ymax, xmax] = it.box_2d;
        // 先换算到这一块（R）里的比例判断归属，再换算到整张截图
        const lx = (x) => x0 + (x / 1000) * (x1 - x0);
        const ly = (y) => y0 + (y / 1000) * (y1 - y0);
        const cx = (lx(xmin) + lx(xmax)) / 2;
        const cy = (ly(ymin) + ly(ymax)) / 2;
        if (cx < ownX[0] || cx >= ownX[1] || cy < ownY[0] || cy >= ownY[1]) return null;
        const gx = (x) => Math.round((R.x0 + lx(x) * RW) * 1000);
        const gy = (y) => Math.round((R.y0 + ly(y) * RH) * 1000);
        const box = [gy(ymin), gx(xmin), gy(ymax), gx(xmax)];
        return { ...it, box_2d: box };
      };
      return { name, base64, width, height, toGlobal };
    })
  );
}

async function encode(bmp, sx, sw, sy, sh, { maxSide = MAX_SIDE, maxPixels = Infinity, quality = 0.85 } = {}) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh), Math.sqrt(maxPixels / (sw * sh)));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), width: w, height: h };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (e) => e.status === 500 || e.status === 503;

async function translateWithFallback(tabId, opts) {
  const { apiKey, model } = opts;
  let retired = false;
  let emitted = false;
  const tracked = { ...opts, onItem: (it) => ((emitted = true), opts.onItem(it)) };
  // 服务繁忙（500/503）通常几秒就好：同一个模型先重试两次
  for (const wait of [0, 2000, 5000]) {
    if (wait) {
      await send(tabId, { type: "loading", text: t("geminiBusy") });
      await sleep(wait);
    }
    try {
      return await translateScreenshot(tracked);
    } catch (e) {
      // 已经显示了一部分译文，再重试会重复画框，直接报错
      if (emitted) throw e;
      if (e.status === 404) {
        retired = true;
        break;
      }
      if (e.status === 429 && !e.daily && !opts.rateRetried) {
        await chrome.storage.session.set({ noSplit: true });
        const secs = Math.min(60, Math.ceil(e.retryAfter));
        await send(tabId, { type: "loading", text: t("rateLimited", { secs }) });
        await sleep(secs * 1000);
        return translateWithFallback(tabId, { ...opts, rateRetried: true });
      }
      if (!isBusy(e)) throw e;
    }
  }
  // 模型下线（404）或一直繁忙：换一个当前可用的模型再试一次
  const others = (await listModels(apiKey)).filter((m) => m.name !== model);
  const next = pickDefaultModel(others);
  await send(tabId, { type: "loading", text: t("switchModel") });
  const items = await translateScreenshot({ ...opts, model: next });
  // 只有旧模型下线了才记住新模型；繁忙只是临时借用
  if (retired) await chrome.storage.local.set({ model: next });
  return items;
}

// 同一画面不重复花钱；只记最近 CACHE_LIMIT 页。按缩略图比较，
// 截图时多了工具栏、鼠标指针附近的小变化都还算同一页
async function lookup(tag, sig) {
  const { cache = [] } = await chrome.storage.session.get("cache");
  const mask = maskFor([]);
  const hit = cache.find((c) => c.tag === tag && diff(sig, Float32Array.from(c.sig), mask) < SAME_PAGE);
  return hit?.items;
}

async function remember(tag, sig, items) {
  const { cache = [] } = await chrome.storage.session.get("cache");
  cache.push({ tag, sig: Array.from(sig, Math.round), items });
  await chrome.storage.session.set({ cache: cache.slice(-CACHE_LIMIT) });
}
