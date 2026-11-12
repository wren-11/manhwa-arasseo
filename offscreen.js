// 标签页录制：Chrome 截图每秒最多 2 张，录制没有这个限制。
// 后台发 start（带 streamId）开始录，grab 取当前画面，stop 停止。
//
// 这个后台页面不会显示出来，<video> 在这里不会真的画到屏幕上：
// requestVideoFrameCallback 可能永远不触发，drawImage 也可能拿到旧画面。
// 所以直接从录制轨道一帧一帧读（MediaStreamTrackProcessor），只留最新的一帧和它到达的时间。
let stream = null;
let reader = null;
let latest = null; // { frame: VideoFrame, at: 到达时间（毫秒） }
let waiters = [];

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== "offscreen") return;
  const done = (p) => (p.then(reply, (e) => reply({ error: e.message || String(e) })), true);
  if (msg.type === "start") return done(start(msg));
  if (msg.type === "grab") return done(grab(msg));
  if (msg.type === "mark") return mark(), reply({ ok: true });
  if (msg.type === "stop") return stop(), reply({ ok: true });
});

async function start({ streamId, width, height }) {
  stop();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        // 和截图一样的尺寸（屏幕像素），坐标才对得上，字也一样清楚
        minWidth: width,
        maxWidth: width,
        minHeight: height,
        maxHeight: height,
        maxFrameRate: 30,
      },
    },
  });
  return begin(stream.getVideoTracks()[0]);
}

// 测试时也从这里接一条别的视频轨道
async function begin(track) {
  reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  readLoop(reader);
  const f = await frameAfter(0, 3000); // 等第一帧，确认真的录上了
  if (!f) throw new Error("录制没有出画面");
  return { ok: true, width: f.frame.displayWidth, height: f.frame.displayHeight };
}

async function readLoop(r) {
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done || r !== reader) {
        value?.close();
        break;
      }
      latest?.frame.close();
      latest = { frame: value, at: Date.now() };
      const w = waiters;
      waiters = [];
      w.forEach((fn) => fn());
    }
  } catch {}
}

// 等一帧 since 之后才到的画面（since = 开始滚动的时刻，之前的帧是上一屏的）
function frameAfter(since, wait) {
  if (latest && latest.at > since) return Promise.resolve(latest);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), wait);
    const check = () => {
      if (!reader) clearTimeout(t), resolve(null);
      else if (latest && latest.at > since) clearTimeout(t), resolve(latest);
      else waiters.push(check);
    };
    waiters.push(check);
  });
}

// 小缩略图（灰度），用来判断两帧看起来是不是一样
const thumbCanvas = new OffscreenCanvas(64, 64);
const thumbCtx = thumbCanvas.getContext("2d", { willReadFrequently: true });
function thumb(frame) {
  if (!frame.displayWidth) return null; // 这一帧已经被更新的一帧换掉了
  thumbCtx.drawImage(frame, 0, 0, 64, 64);
  const d = thumbCtx.getImageData(0, 0, 64, 64).data;
  const g = new Uint8Array(64 * 64);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
  return g;
}
const same = (a, b) => {
  if (!a || !b) return false;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length < 1.5;
};

// 滚动之前记下当时的画面。录制的画面会比页面慢一点点：滚动之后先到的几帧可能还是滚动前的样子，
// 所以要等到"和滚动前不一样"的画面才算滚过去了
let before = null;
function mark() {
  before = latest ? { at: Date.now(), thumb: thumb(latest.frame) } : null;
}

// 拿滚动之后、画面稳定下来的那一帧：先等到和滚动前不一样的一帧，再看画面是不是不变了。
// 不变的判断：120 毫秒没有新帧（画面不变时录制不出新帧），或者新来的一帧和上一帧看起来一样
// （有的网站页面上一直有小动画，帧不停地来，但漫画本身已经停了）。最多再等 600 毫秒。
// 没有 mark 过（同一位置再取一次）：不用等新帧，直接等画面稳定。
// 一直等不到变化（滚过去的地方和原来一模一样，比如大片白底）就告诉后台 stale，让它改用截图确认
async function grab({ quality = 0.85, wait = 1500 } = {}) {
  if (!reader) throw new Error("没有在录制");
  const t = Date.now();
  let f = latest;
  const b = before;
  before = null;
  if (b) {
    f = null;
    let since = b.at;
    while (Date.now() - t < wait) {
      const g = await frameAfter(since, wait - (Date.now() - t));
      if (!g) break;
      since = g.at;
      if (!same(thumb(g.frame), b.thumb)) {
        f = g;
        break;
      }
    }
    if (!f) return { stale: true, info: `等了 ${Date.now() - t} 毫秒，画面和滚动前一样` };
  }
  if (!f) throw new Error("录制没有画面");
  const t0 = Date.now();
  let frames = 0;
  let prev = thumb(f.frame);
  while (Date.now() - t0 < 600) {
    const g = await frameAfter(f.at, 120);
    if (!g) break;
    f = g;
    frames++;
    const cur = thumb(f.frame);
    if (same(cur, prev)) break;
    prev = cur;
  }
  const t1 = Date.now();
  if (!f.frame.displayWidth) f = latest; // 刚被更新的一帧换掉了：就用最新的
  // 同步画图、同步转 JPEG：这个后台页面看不见，异步的转图会被 Chrome 降速（之前一张要 1 秒）
  const w = f.frame.displayWidth;
  const h = f.frame.displayHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(f.frame, 0, 0);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const info = `等新画面 ${t0 - t} 毫秒，等稳定 ${t1 - t0} 毫秒（期间又来 ${frames} 帧），转图 ${Date.now() - t1} 毫秒，${w}×${h}`;
  return { dataUrl, info };
}

function stop() {
  const r = reader;
  reader = null;
  r?.cancel().catch(() => {});
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  latest?.frame.close();
  latest = null;
  const w = waiters;
  waiters = [];
  w.forEach((fn) => fn());
}
