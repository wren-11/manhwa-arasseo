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
  // 设置页现在有通义千问、Claude 和 OpenAI；以前存的 Gemini（代码还留着，以后可以加回来）也按设置页显示的默认值走
  const provider = ["claude", "qwen", "openai"].includes(savedProvider) ? savedProvider : "qwen";
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

// 换哪一段都会一样失败的错误（key 不对、欠费、额度用完、今天的次数用完）才停下整轮
const FATAL_CODES = new Set(["Arrearage", "AccessDenied", "Model.AccessDenied", "insufficient_quota"]);
const fatalError = (e) =>
  [401, 402, 403].includes(e.status) || (e.status === 429 && e.daily) || FATAL_CODES.has(e.code) || /credit balance|余额|欠费|额度/i.test(e.message);

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
  st.latestJob = job; // 按钮只显示最新这一轮的进度
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
  // 又开了新的一轮：旧的这轮只管在后台翻完，不再改按钮（不然两轮的进度会来回跳）
  const status = () =>
    st.latestJob === job &&
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
          } else if (e.name === "AbortError") done++;
          else if (fatalError(e)) job.error ||= e;
          else {
            // 只是这一段出错（内容审核没过、超时、服务器一时出错）：跳过这段接着翻别的，不让整轮停下。
            // 这段没记成翻过，之后看到这里时边看边翻会再试一次
            done++;
            console.debug(`[预翻译] 段 ${Math.round(task.band?.[0] ?? 0)}–${Math.round(task.band?.[1] ?? 0)} 没翻成，跳过：`, e.message);
          }
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
      if (now.scrollTop + H >= now.scrollHeight - 2) {
        // 看起来到底了。很长的一话，网站常常滑到底附近才接着加载后面的部分（页面会变长）：
        // 等一会儿，变长了就接着往下扫，确定不再变长才算真的到底
        let grew = false;
        for (let t = 0; t < 10 && !job.stop; t++) {
          await sleep(250);
          const v = await ask(tab.id, { type: "geom" });
          if (v?.strip && v.scrollHeight > now.scrollHeight + 20) {
            grew = true;
            break;
          }
        }
        if (!grew) break; // 真的到底了
        console.debug("[预翻译] 页面变长了（网站接着加载了后面的部分），继续往下扫");
      }
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

// ---------- 用截图校正模型给的框 ----------
// 模型（尤其千问）给的位置常常偏一点、大一点，或者把一个对话框按行拆成几条。
// 在模型的框附近找真正的白色对话框（或白底）和里面的字，把框挪到字上、缩到字的大小。
// 找不到可靠的白底（深色对话框、字直接写在画上）就原样用模型的框。
async function makeRefiner(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const S = Math.min(1, 1000 / bmp.width);
  const W = Math.max(1, Math.round(bmp.width * S));
  const H = Math.max(1, Math.round(bmp.height * S));
  const ctx = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
  const LIGHT = 238; // 对话框、白底都接近纯白；浅色的天空、背景不算
  const INK = 170; // 比这深的才算字的笔画
  let cur = null;
  const dbg = (m) => console.debug("[校正] 用模型原来的框：" + m + " 框=" + cur);

  // 先在框附近找；找不到封闭的对话框（可能被窗口切到了）就看大一点再找，最后才退回"白底上的字"
  return (box) => {
    cur = box.map(Math.round).join(",") + ` 图 ${W}×${H}`;
    for (const k of [0.6, 1.2, 2]) {
      const r = attempt(box, k, false);
      if (r) return r;
    }
    return attempt(box, 0.6, true);
  };

  function attempt(box, k, allowOpen) {
    const say = (m) => allowOpen && dbg(m);
    const [ymin, xmin, ymax, xmax] = box;
    const bx0 = (xmin / 1000) * W, bx1 = (xmax / 1000) * W, by0 = (ymin / 1000) * H, by1 = (ymax / 1000) * H;
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw < 3 || bh < 3) return null;
    // 在模型的框四周多看一圈（按框的长边算）：框偏了、或者只是对话框里的一行，也能看到整个对话框
    const e = Math.max(24, Math.max(bw, bh) * k);
    const wx0 = Math.max(0, Math.floor(bx0 - e)), wx1 = Math.min(W, Math.ceil(bx1 + e));
    const wy0 = Math.max(0, Math.floor(by0 - e)), wy1 = Math.min(H, Math.ceil(by1 + e));
    const ww = wx1 - wx0, wh = wy1 - wy0;
    if (ww < 8 || wh < 8) return null;
    const at = (x, y) => gray[(wy0 + y) * W + wx0 + x];
    const light = (x, y) => at(x, y) >= LIGHT;
    // 周围 5×5 都是白的点才能当起点（避开字缝里、画里零星的亮点）
    const solid = (x, y) => {
      if (x < 2 || y < 2 || x >= ww - 2 || y >= wh - 2) return false;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (!light(x + i, y + j)) return false;
      return true;
    };
    const cx = (bx0 + bx1) / 2 - wx0, cy = (by0 + by1) / 2 - wy0;
    const cands = [];
    for (let y = 2; y < wh - 2; y += 2)
      for (let x = 2; x < ww - 2; x += 2) if (solid(x, y)) cands.push([(x - cx) ** 2 + (y - cy) ** 2, y * ww + x]);
    if (!cands.length) return say("附近没有白底"), null;
    cands.sort((p, q) => p[0] - q[0]);
    // 从离框中心最近的白点开始，把连在一起的白色铺满。优先用"封闭"的一块（对话框里面，不碰窗口边）
    const fill = (seed) => {
      const reg = new Uint8Array(ww * wh);
      const stack = [seed];
      reg[seed] = 1;
      let area = 0, touches = false, edgeTop = false, edgeBottom = false, rx0 = ww, ry0 = wh, rx1 = 0, ry1 = 0;
      while (stack.length) {
        const p = stack.pop();
        area++;
        const x = p % ww, y = (p / ww) | 0;
        if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; if (y < ry0) ry0 = y; if (y > ry1) ry1 = y;
        if (x === 0 || y === 0 || x === ww - 1 || y === wh - 1) touches = true;
        if (y === 0 && wy0 === 0) edgeTop = true; // 碰到整张截图的上边
        if (y === wh - 1 && wy1 === H) edgeBottom = true;
        if (x > 0 && !reg[p - 1] && light(x - 1, y)) (reg[p - 1] = 1), stack.push(p - 1);
        if (x < ww - 1 && !reg[p + 1] && light(x + 1, y)) (reg[p + 1] = 1), stack.push(p + 1);
        if (y > 0 && !reg[p - ww] && light(x, y - 1)) (reg[p - ww] = 1), stack.push(p - ww);
        if (y < wh - 1 && !reg[p + ww] && light(x, y + 1)) (reg[p + ww] = 1), stack.push(p + ww);
      }
      return { reg, area, touches, edgeTop, edgeBottom, rb: [ry0, rx0, ry1 + 1, rx1 + 1] };
    };
    let pick = null;
    const tried = [];
    for (const [d, seed] of cands) {
      if (tried.some((t) => t.reg[seed])) continue;
      if (tried.length >= 40 || d > e * e * 9) break;
      const f = fill(seed);
      tried.push(f);
      if (!f.touches && f.area >= bw * bh * 0.25) { pick = f; break; }
    }
    if (!pick && !allowOpen) return null;
    pick ||= tried[0];
    if (!pick) return say("附近没有白底"), null;
    const { reg: region, area, touches, rb, edgeTop, edgeBottom } = pick;
    if (area < bw * bh * 0.15) return say(`白的太少 ${area}/${Math.round(bw * bh)}`), null; // 白的太少：不是白底上的字
    // 3. 从窗口边上把不是白色的地方铺满（画、对话框的边线、外面）；剩下没铺到的非白点就是被白色包住的字
    const outside = new Uint8Array(ww * wh);
    const st = [];
    for (let x = 0; x < ww; x++) for (const y of [0, wh - 1]) { const p = y * ww + x; if (!region[p] && !outside[p]) (outside[p] = 1), st.push(p); }
    for (let y = 0; y < wh; y++) for (const x of [0, ww - 1]) { const p = y * ww + x; if (!region[p] && !outside[p]) (outside[p] = 1), st.push(p); }
    while (st.length) {
      const p = st.pop();
      const x = p % ww, y = (p / ww) | 0;
      for (const [q, ok] of [[p - 1, x > 0], [p + 1, x < ww - 1], [p - ww, y > 0], [p + ww, y < wh - 1]])
        if (ok && !region[q] && !outside[q]) (outside[q] = 1), st.push(q);
    }
    // 白底一直连到窗口外（大片白底上的字，不是封闭的对话框）：只认模型框附近的字，免得把旁边别的句子也算进来
    const lim = touches
      ? { x0: bx0 - wx0 - bw * 0.15, x1: bx1 - wx0 + bw * 0.15, y0: by0 - wy0 - bh * 0.15, y1: by1 - wy0 + bh * 0.15 }
      : { x0: 0, x1: ww, y0: 0, y1: wh };
    // 字的像素：被白色包住、颜色够深（JPEG 在白底上留下的浅灰杂点不算）
    const inkMask = new Uint8Array(ww * wh);
    let ink = 0;
    for (let y = 0; y < wh; y++)
      for (let x = 0; x < ww; x++) {
        const p = y * ww + x;
        if (region[p] || outside[p]) continue;
        if (x < lim.x0 || x > lim.x1 || y < lim.y0 || y > lim.y1) continue;
        if (at(x, y) > INK) continue;
        inkMask[p] = 1;
        ink++;
      }
    // 把字分成一段一段：先找出每个笔画块，再把离得近的（同一行的字、上下相邻的行）连成一段。
    // 两个连在一起的对话框（白色是通的）里的两段话离得远，会分成两段；只要和模型的框重叠的那段
    const comps = [];
    {
      const seen = new Uint8Array(ww * wh);
      const st2 = [];
      for (let p0 = 0; p0 < inkMask.length; p0++) {
        if (!inkMask[p0] || seen[p0]) continue;
        let cx0 = ww, cy0 = wh, cx1 = -1, cy1 = -1, n = 0;
        seen[p0] = 1;
        st2.push(p0);
        while (st2.length) {
          const p = st2.pop();
          n++;
          const x = p % ww, y = (p / ww) | 0;
          if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
          for (let j = -1; j <= 1; j++)
            for (let i = -1; i <= 1; i++) {
              const nx = x + i, ny = y + j;
              if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
              const q = ny * ww + nx;
              if (inkMask[q] && !seen[q]) (seen[q] = 1), st2.push(q);
            }
        }
        if (n >= 3) comps.push([cx0, cy0, cx1, cy1]);
        if (comps.length > 3000) break;
      }
    }
    const hs = comps.map((c) => c[3] - c[1] + 1).filter((h) => h >= 3).sort((a, b) => a - b);
    const glyph = hs.length ? Math.max(4, hs[Math.floor(hs.length * 0.7)]) : 8;
    const parent = comps.map((_, i) => i);
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let i = 0; i < comps.length; i++)
      for (let j = i + 1; j < comps.length; j++) {
        const A = comps[i], B = comps[j];
        const gx = Math.max(0, Math.max(A[0], B[0]) - Math.min(A[2], B[2]));
        const gy = Math.max(0, Math.max(A[1], B[1]) - Math.min(A[3], B[3]));
        if (gx <= glyph * 1.2 && gy <= glyph * 0.9) parent[root(i)] = root(j);
      }
    const groups = new Map();
    comps.forEach((c, i) => {
      const r = root(i);
      const g = groups.get(r);
      if (!g) groups.set(r, c.slice());
      else (g[0] = Math.min(g[0], c[0])), (g[1] = Math.min(g[1], c[1])), (g[2] = Math.max(g[2], c[2])), (g[3] = Math.max(g[3], c[3]));
    });
    const mbx0 = bx0 - wx0, mbx1 = bx1 - wx0, mby0 = by0 - wy0, mby1 = by1 - wy0;
    const blocks = [...groups.values()];
    let picked = blocks.filter((g) => g[2] >= mbx0 && g[0] <= mbx1 && g[3] >= mby0 && g[1] <= mby1);
    if (!picked.length && blocks.length) {
      const d = (g) => Math.hypot((g[0] + g[2]) / 2 - (mbx0 + mbx1) / 2, (g[1] + g[3]) / 2 - (mby0 + mby1) / 2);
      picked = [blocks.reduce((m, g) => (d(g) < d(m) ? g : m))];
    }
    let tx0 = Infinity, ty0 = Infinity, tx1 = -1, ty1 = -1;
    for (const g of picked) {
      if (g[0] < tx0) tx0 = g[0]; if (g[1] < ty0) ty0 = g[1]; if (g[2] > tx1) tx1 = g[2]; if (g[3] > ty1) ty1 = g[3];
    }
    if (ink < 8 || tx1 < tx0) {
      // 对话框被截图的上下边切开了，框附近看不到字：告诉调用的地方"被切开"，这次先不画，等整个露出来再翻
      if (edgeBottom || edgeTop) return say("对话框被截图边缘切开"), { cut: edgeBottom ? "bottom" : "top" };
      return say(`没找到字 ink=${ink} touches=${touches}`), null;
    }
    // 字和模型的框差太远（比如找到的是别的对话框）就不信
    const rw = tx1 - tx0 + 1, rh = ty1 - ty0 + 1;
    if (rw * rh < bw * bh * 0.04 || rw * rh > bw * bh * 6) return say(`大小差太多 ${rw}×${rh} vs ${Math.round(bw)}×${Math.round(bh)}`), null;
    const pad = 2;
    // 模型的框贴着字、大部分在这个对话框里（位置本来就准，Claude 通常这样）：和找到的字合在一起用。
    // 字贴着对话框边线时（比如两头的括号），那几个字会被当成边线、找不全，模型的框能补上。
    // 模型的框比字大很多（千问常把整个对话框当成一个框，圆对话框四个角外面就是人脸）或者偏了：只用找到的字
    const textArea = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    // 找到的字离模型的框太远：多半跳到了旁边另一个对话框上，不信
    const dcx = (tx0 + tx1) / 2 - ((bx0 + bx1) / 2 - wx0), dcy = (ty0 + ty1) / 2 - ((by0 + by1) / 2 - wy0);
    if (Math.hypot(dcx, dcy) > Math.max(bw, bh) * 0.9 + 20) return say("找到的字离模型的框太远"), null;
    // 模型的框和找到的字重合得多（框本来就准）才合在一起用；偏了一半的框只用找到的字
    const ox = Math.min(bx1 - wx0, tx1 + 1) - Math.max(bx0 - wx0, tx0);
    const oy = Math.min(by1 - wy0, ty1 + 1) - Math.max(by0 - wy0, ty0);
    const agree = ox > 0 && oy > 0 && (ox * oy) / (bw * bh) >= 0.5;
    if (agree && bw * bh <= textArea * 2.5) {
      // 封闭的对话框：只取模型的框落在对话框里的部分；白底连成一片时：用模型的框本身
      const lim2 = touches ? [0, 0, wh, ww] : rb;
      const ix0 = Math.max(bx0 - wx0, lim2[1]), ix1 = Math.min(bx1 - wx0, lim2[3]);
      const iy0 = Math.max(by0 - wy0, lim2[0]), iy1 = Math.min(by1 - wy0, lim2[2]);
      if (ix1 > ix0 && iy1 > iy0 && (ix1 - ix0) * (iy1 - iy0) >= bw * bh * 0.7) {
        tx0 = Math.min(tx0, ix0); tx1 = Math.max(tx1, ix1 - 1);
        ty0 = Math.min(ty0, iy0); ty1 = Math.max(ty1, iy1 - 1);
      }
    }
    const gx = (x) => Math.round(((wx0 + x) / W) * 1000);
    const gy = (y) => Math.round(((wy0 + y) / H) * 1000);
    return {
      box: [gy(ty0 - pad), gx(tx0 - pad), gy(ty1 + 1 + pad), gx(tx1 + 1 + pad)],
      // 封闭的对话框本身的范围：同一个对话框里拆开的几行，靠它认出是一家
      bubble: touches ? null : [gy(rb[0]), gx(rb[1]), gy(rb[2]), gx(rb[3])],
    };
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
  const masks = covers.map((m) => ({ x0: m.left / g.vw, x1: m.right / g.vw, y0: m.top / g.vh, y1: m.bottom / g.vh }));
  // 预翻译时不切：一段一张图发过去（试过千问也切成两块，请求翻倍、更慢，切线附近的框反而更乱）
  const splitRows = allowSplit && bandH * g.vh > 480 && !opts.prefetch;
  const pieces = await splitScreenshot(dataUrl, { cols: false, rows: splitRows, overlapY: 0.25, masks }, limits, region);
  const shade = await shader(dataUrl);
  const refine = await makeRefiner(dataUrl).catch((e) => (console.warn("[校正] 出错，这一段不校正：", e), null));
  let fixedN = 0, rawN = 0;
  const mineItems = []; // 这一段这次画的框：同一个对话框被拆成几行时合并成一个
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
          const rawBox = item.box_2d.slice();
          let fixed = null;
          try {
            fixed = refine?.(item.box_2d) || null;
          } catch (e) {
            console.warn("[校正] 出错：", e);
          }
          if (fixed?.box) fixedN++;
          else if (!fixed) rawN++;
          if (fixed?.cut) {
            const k0 = toC(item.box_2d[0]), k1 = toC(item.box_2d[2]);
            // 模型给的框离那条边还有距离：模型看到的是整段字，没被切开。
            // 校正说"切开"只是因为在白色里找不到字（白色描边的大字连着浅色背景时会这样），就用模型原来的框
            const away = fixed.cut === "bottom" ? band1 - k1 : k0 - band0;
            if (away > EDGE) {
              console.debug(`[校正] 说对话框被${fixed.cut === "bottom" ? "下" : "上"}边切开，但模型的框 ${Math.round(k0)}–${Math.round(k1)} 离边还有 ${Math.round(away)}px，用模型的框`);
              fixed = null;
              rawN++;
            }
          }
          if (fixed?.cut) {
            const k0 = toC(item.box_2d[0]), k1 = toC(item.box_2d[2]);
            console.debug(`[条漫] 丢掉 ${Math.round(k0)}–${Math.round(k1)}（段 ${Math.round(band0)}–${Math.round(band1)}）：对话框被截图${fixed.cut === "bottom" ? "下" : "上"}边切开`);
            if (fixed.cut === "bottom" && !atBottom) hi = Math.min(hi, k0);
            else if (fixed.cut === "top" && !atTop) lo = Math.max(lo, k1);
            else fixed = null;
            if (fixed) return;
          }
          // 模型给的位置离得远、校正后却对到了同一段字上：多半是校正跑偏了
          // （爆炸框、锯齿框边上是开口的，白色连到外面，找到的是旁边对话框的字），这条就用模型原来的框，免得被当成同一个对话框接到别人后面
          if (fixed?.box) {
            const fb = [toC(fixed.box[0]), fixed.box[1], toC(fixed.box[2]), fixed.box[3]];
            const rb = [toC(rawBox[0]), rawBox[1], toC(rawBox[2]), rawBox[3]];
            const stolen = mineItems.find((m) => m.refined && overlaps(m.cbox, fb) && !rawNear(m.rawC, rb));
            if (stolen) {
              console.debug(`[校正] 校正后和别的对话框对到同一段字，但模型给的位置离得远，用原来的框：${Math.round(rb[0])}–${Math.round(rb[2])}`);
              fixed = null;
              fixedN--;
              rawN++;
            }
          }
          if (fixed) item.box_2d = fixed.box;
          const c0 = toC(item.box_2d[0]);
          const c1 = toC(item.box_2d[2]);
          // 贴着截图上下边缘的框多半被切掉了一半：先不画，这一段也不算翻过，等它整个露出来再翻
          const tall = c1 - c0 > bh * 0.6;
          const why = (r) => console.debug(`[条漫] 丢掉 ${Math.round(c0)}–${Math.round(c1)}（段 ${Math.round(band0)}–${Math.round(band1)}）：${r}「${item.translation.slice(0, 20)}」`);
          if (!tall && !atTop && c0 - band0 < EDGE) return void ((lo = Math.max(lo, c1)), why("贴着上边"));
          if (!tall && !atBottom && band1 - c1 < EDGE) return void ((hi = Math.min(hi, c0)), why("贴着下边"));
          const cover = underCover(item.box_2d);
          // 可能只看到一半，等露出来再翻：挡在下面的从下边收，挡在上面的从上边收
          if (cover) return void (isLower(cover) ? (hi = Math.min(hi, c0)) : (lo = Math.max(lo, c1)), why("被挡住"));
          const cbox = [c0, item.box_2d[1], c1, item.box_2d[3]];
          cbox.id = `b${++boxSeq}`;
          // 和已经画过的框是同一处：新的明显更完整（比如上次只看到半个对话框）就换掉旧的，否则丢掉新的
          const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
          // 同一次回答里落在同一处（同一个对话框被拆成几行，校正后都对到了整段字上）：把译文接到那个框后面
          // 只合并同一块图的同一次回答：上下两块重叠处的同一个对话框，两边各翻一遍，那是重复，不是拆行
          const toCB = (b) => b && [toC(b[0]), b[1], toC(b[2]), b[3]];
          const me = { rawC: toCB(rawBox), bub: toCB(fixed?.bubble), refined: !!fixed };
          const centerIn = (b, r) => r && (b[0] + b[2]) / 2 > r[0] && (b[0] + b[2]) / 2 < r[2] && (b[1] + b[3]) / 2 > r[1] && (b[1] + b[3]) / 2 < r[3];
          // 只在确认是同一个封闭对话框时才合并（至少一边校正成功、找到了对话框的边）；
          // 都没校正成功时，模型的大框互相重叠不能说明什么，合并会把两个对话框的话接在一起
          // 只在两条对到的是同一段字时才合并：都校正过且对到同一段字，或者没校正的那条正好落在另一条找到的那段字上
          const grow = (b, k) => { const h = (b[2] - b[0]) * k, w = (b[3] - b[1]) * k; return [b[0] - h, b[1] - w, b[2] + h, b[3] + w]; };
          const sameBubble = (m) =>
            m.piece === piece &&
            rawNear(m.rawC, me.rawC) &&
            ((m.refined && me.refined && touch(m.cbox, cbox)) ||
              (m.refined && !me.refined && centerIn(me.rawC, grow(m.cbox, 0.2))) ||
              (me.refined && !m.refined && centerIn(m.rawC, grow(cbox, 0.2))));
          const sib = mineItems.find(sameBubble);
          if (sib) {
            const t = item.translation.trim();
            if (sib.item.translation.includes(t)) return void why("同一个对话框里重复的句子");
            // 模型有时同时给"整段一个框"和"每行一个框"，内容是重复的：
            // 新的这条整个落在已有的大框里 → 是其中一行，丢掉；新的反过来把已有的整个包住 → 新的是整段，用它的译文
            const inside = (a, b) => {
              const w = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
              const h = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
              return w > 0 && h > 0 && (w * h) / area(a) > 0.8;
            };
            if (inside(me.rawC, sib.rawC) && area(sib.rawC) > area(me.rawC) * 1.8) return void why("是已有整段里的一行");
            if (inside(sib.rawC, me.rawC) && area(me.rawC) > area(sib.rawC) * 1.8) {
              sib.item.translation = t;
              sib.rawC = me.rawC;
              why("整段的译文换掉之前的一行");
              send(tab.id, { type: "stripAdd", item: sib.item, replace: sib.item.id, anchor: { scrollTop: g.scrollTop, top: g.rect.top, left: g.rect.left } });
              return;
            }
            sib.item.translation += (CJK_RE.test(t) ? "" : " ") + t;
            // 框用校正过的那个；都校正过（或都没校正）就用大的
            if (me.refined && sib.refined) {
              // 都对准了字（同一个对话框里的几行）：框合成一个，把几行都包住
              const u = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
              sib.item.box_2d = u(sib.item.box_2d, item.box_2d);
              sib.cbox.splice(0, 4, ...u(sib.cbox, cbox));
            } else if ((me.refined && !sib.refined) || (me.refined === sib.refined && area(cbox) > area(sib.cbox))) {
              sib.item.box_2d = item.box_2d;
              sib.cbox.splice(0, 4, ...cbox);
              sib.refined ||= me.refined;
              sib.bub ||= me.bub;
              sib.cbox.refined = sib.refined;
            }
            why("和同一个对话框里的上一行合并");
            send(tab.id, { type: "stripAdd", item: sib.item, replace: sib.item.id, anchor: { scrollTop: g.scrollTop, top: g.rect.top, left: g.rect.left } });
            return;
          }
          // GPT 爱把一段字（拟声词、竖排字、大字）拆成几小块，框叠在一起但不到"重叠"的标准，画出来是一摞。
          // 同一次回答里、都没对到对话框上的两个框，只要叠到一点就合成一个：译文一样就只留一个，不一样就按阅读顺序接起来
          if (conf.provider === "openai" && !me.refined) {
            const inter = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
            const ar = (b) => (b[2] - b[0]) * (b[3] - b[1]);
            const frag = mineItems.find((m) => m.piece === piece && !m.refined && inter(m.cbox, cbox) > Math.min(ar(m.cbox), ar(cbox)) * 0.1);
            if (frag) {
              const t = item.translation.trim();
              const ft = frag.item.translation.trim();
              if (normSrc(ft) === normSrc(t) || ft.includes(t)) return void why("和叠在一起的 GPT 框是同一句");
              const before = c0 < frag.cbox[0] - 4 || (Math.abs(c0 - frag.cbox[0]) <= 4 && item.box_2d[1] < frag.cbox[1]);
              const sep = CJK_RE.test(t) && CJK_RE.test(ft) ? "" : " ";
              frag.item.translation = t.includes(ft) ? t : before ? t + sep + ft : ft + sep + t;
              const u = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
              frag.item.box_2d = u(frag.item.box_2d, item.box_2d);
              frag.cbox.splice(0, 4, ...u(frag.cbox, cbox));
              frag.rawC = u(frag.rawC, me.rawC);
              why("和叠在一起的 GPT 框合成一个");
              send(tab.id, { type: "stripAdd", item: frag.item, replace: frag.item.id, anchor: { scrollTop: g.scrollTop, top: g.rect.top, left: g.rect.left } });
              return;
            }
          }
          // 上下两块重叠处的同一句：两块各翻一遍，位置常常一个准一个偏，框不重叠就认不出来。
          // 按模型抄下的原文认：别的块里离得不远、原文一样的，只留一个（校正过的优先）
          const key = normSrc(item.src);
          const twin = key.length >= 2 && mineItems.find((m) => m.piece !== piece && m.key && (m.key === key || (Math.min(m.key.length, key.length) >= 4 && (m.key.includes(key) || key.includes(m.key)))) && Math.abs((m.cbox[0] + m.cbox[2]) / 2 - (c0 + c1) / 2) < bh * 0.5);
          if (twin) {
            if (!(me.refined && !twin.refined)) return void why(`另一块已经翻过同一句「${item.src.slice(0, 12)}」`);
            strip.items.splice(strip.items.indexOf(twin.cbox), 1);
            mineItems.splice(mineItems.indexOf(twin), 1);
            why(`同一句另一块的位置没校正，换成这个「${item.src.slice(0, 12)}」`);
            cbox.refined = true;
            strip.items.push(cbox);
            item.id = cbox.id;
            item.dark = shade(item.box_2d);
            mineItems.push({ cbox, item, piece, key, ...me });
            send(tab.id, { type: "stripAdd", item, replace: twin.item.id, anchor: { scrollTop: g.scrollTop, top: g.rect.top, left: g.rect.left } });
            return;
          }
          // 和已经画过的框是同一处：校正过的（对准了字）优先于没校正的（模型原来的大框）；
          // 都校正过或都没校正，新的明显更大（比如上次只看到半个对话框）才换
          cbox.refined = me.refined;
          const old = strip.items.find((b) => overlaps(b, cbox));
          const better = old && ((cbox.refined && !old.refined) || (cbox.refined === !!old.refined && area(cbox) > area(old) * 1.25));
          if (old && !better) return void why(`重复（和已画的 ${Math.round(old[0])}–${Math.round(old[2])} 那个）`);
          if (old) strip.items.splice(strip.items.indexOf(old), 1), why(cbox.refined && !old.refined ? "校正过的换掉没校正的大框" : "比之前画的完整，换掉旧的");
          strip.items.push(cbox);
          item.id = cbox.id;
          item.dark = shade(item.box_2d);
          count++;
          mineItems.push({ cbox, item, piece, key, ...me });
          console.debug(`[条漫] 画 ${Math.round(c0)}–${Math.round(c1)}${fixed ? "（校正过）" : ""}「${item.translation.slice(0, 20)}」`);
          send(tab.id, { type: "stripAdd", item, replace: old?.id, anchor: { scrollTop: g.scrollTop, top: g.rect.top, left: g.rect.left } });
        },
      })
    )
  );
  console.debug(`[校正] 段 ${Math.round(band0)}–${Math.round(band1)}：模型给了 ${fixedN + rawN} 个框，校正了 ${fixedN} 个，用原来的 ${rawN} 个`);
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

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/;


// 交叠部分占较小那个框的六成以上，就算是同一段文字
// 模型给的两个原始框是不是同一个对话框里上下相邻的几行：左右有重叠，上下的空隙不超过矮的那个框高度的八成。
// （同一个对话框拆成几行时，行和行之间只隔一点点；两个不同的对话框之间隔得远）
// 框的格式是 [y0（像素）, x0（0–1000）, y1（像素）, x1（0–1000）]
function rawNear(a, b) {
  if (!a || !b) return true;
  const xo = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const gapY = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
  const minH = Math.min(a[2] - a[0], b[2] - b[0]);
  return xo > -20 && gapY <= Math.max(minH * 0.8, 6);
}

// 两个框有交叠（多少都算）
function touch(a, b) {
  return Math.min(a[3], b[3]) > Math.max(a[1], b[1]) && Math.min(a[2], b[2]) > Math.max(a[0], b[0]);
}

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

// shortSide：短边最多多少像素（OpenAI 会在内部把短边缩到 768，先缩好，坐标才对得上）
async function encode(bmp, sx, sw, sy, sh, { maxSide = MAX_SIDE, maxPixels = Infinity, shortSide = Infinity, quality = 0.85 } = {}) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh), shortSide / Math.min(sw, sh), Math.sqrt(maxPixels / (sw * sh)));
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

// 比较两块里抄下的原文是不是同一句：去掉空格和标点（模型抄的时候标点、省略号常常不一样）
const normSrc = (s) => (s || "").replace(/[\s\p{P}\p{S}]/gu, "");
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
