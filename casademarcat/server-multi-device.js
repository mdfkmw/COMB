// server-multi-device.js — Bridge multi-device pentru Datecs DP-05 (NU DP-05C)
// Un singur server HTTP pentru mai multe case de marcat.
// Selectezi device-ul prin query: ?dev=A sau ?dev=B
// A → COM5, B → COM6 (implicit 115200 baud)
// Endpoints: /nf/* și /fiscal/* — identice cu varianta single-device
// Handle: TAB final, SYN loop (așteptare frame complet), NO_PAPER, map card→6

const express = require("express");
const { SerialPort } = require("serialport");

const app = express();
app.use(express.json());


// CORS pentru site-ul tău + dev local (inclusiv credențiale + PNA)
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const ALLOWLIST = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://diagrama.pris-com.ro',
    'https://diagrama.pris-com.ro',
    'http://www.diagrama.pris-com.ro',
    'https://www.diagrama.pris-com.ro',      // ← schimbă cu domeniul tău real de producție
  ];
  if (ALLOWLIST.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Pentru Private Network Access (Chrome/Edge)
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  next();
});




// ── Config implicit + ENV overrides ──────────────────────────────────────────
const HTTP_PORT = Number(process.env.HTTP_PORT || 9000);
const DEFAULT_BAUD = Number(process.env.DEFAULT_BAUD || 115200);
const RESPONSE_TIMEOUT_MS = Number(process.env.RESPONSE_TIMEOUT_MS || 6000);
const DEFAULT_CMD_RETRIES = Math.max(1, Number(process.env.CMD_RETRIES || 2));
const DEFAULT_CMD_RETRY_DELAY_MS = Math.max(0, Number(process.env.CMD_RETRY_DELAY_MS || 150));

const DEVICES = [
  { id: "A", path: process.env.DEV_A_PORT || "COM5", baud: Number(process.env.DEV_A_BAUD || DEFAULT_BAUD) },
  { id: "B", path: process.env.DEV_B_PORT || "COM6", baud: Number(process.env.DEV_B_BAUD || DEFAULT_BAUD) },
];

// ── Helpers comune ───────────────────────────────────────────────────────────
function toMoneyDot(x, decimals = 2) {
  const s = String(x).replace(",", ".").trim();
  const n = Number(s);
  return n.toFixed(decimals);
}
function toQtyDot(x) {
  const s = String(x ?? "1").replace(",", ".").trim();
  const n = Number(s);
  return (isNaN(n) ? 1 : n).toFixed(3);
}
function mapTaxCd(x) {
  if (x == null) return "1"; // default A
  const t = String(x).trim().toUpperCase();
  const map = { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6", G: "7" };
  if (map[t]) return map[t];
  if (/^[1-7]$/.test(t)) return t;
  return "1";
}
function mapPayMode(x) {
  const s = String(x ?? "0").trim().toUpperCase();
  // mapez "card"/"1" la 6 (modern payment)
  if (s === "CARD" || s === "MODERN" || s === "6" || s === "1") return "6";
  if (s === "CASH" || s === "0") return "0";
  return /^[0-9]$/.test(s) ? s : "0";
}
function isPaperError(e) {
  const msg = String(e?.message || e || "");
  return msg.includes("-111008") || msg.includes("-111009"); // NO_PAPER / PRINTER_ERROR
}

// ── Clasă Device (câte una per casă) ─────────────────────────────────────────
class Device {
  constructor({ id, path, baud }) {
    this.id = id;
    this.path = path;
    this.baud = baud;
    this.seq = 0x20;
    this.queue = Promise.resolve(); // serializează comenzile
    this.responseTimeout = Number(process.env[`DEV_${id}_TIMEOUT_MS`] || RESPONSE_TIMEOUT_MS);
    this.retryCount = Math.max(1, Number(process.env[`DEV_${id}_RETRIES`] || DEFAULT_CMD_RETRIES));
    this.retryDelayMs = Math.max(0, Number(process.env[`DEV_${id}_RETRY_DELAY_MS`] || DEFAULT_CMD_RETRY_DELAY_MS));
    this.serial = new SerialPort({ path, baudRate: baud }, (err) => {
      if (err) console.error(`❌ [${id}] Serial open:`, err.message);
      else console.log(`✅ [${id}] Conectat la Datecs DP-05 pe ${path} @${baud}`);
    });
  }
  encWord(word16) {
    const n3 = (word16 >> 12) & 0xF, n2 = (word16 >> 8) & 0xF, n1 = (word16 >> 4) & 0xF, n0 = word16 & 0xF;
    return Buffer.from([0x30 + n3, 0x30 + n2, 0x30 + n1, 0x30 + n0]);
  }
  buildFrame(cmdHex, dataBuf = Buffer.alloc(0)) {
    const PRE = Buffer.from([0x01]), PST = Buffer.from([0x05]), EOT = Buffer.from([0x03]);
    this.seq = this.seq >= 0xFF ? 0x20 : this.seq + 1;
    const SEQ = Buffer.from([this.seq]);
    const CMD = this.encWord(cmdHex & 0xFFFF);
    const core = Buffer.concat([SEQ, CMD, dataBuf, PST]);
    const lenValue = core.length + 4 /*LEN*/ + 0x20;
    const LEN = this.encWord(lenValue & 0xFFFF);
    let sum = 0;
    for (const b of Buffer.concat([LEN, core])) sum = (sum + b) & 0xFFFF;
    const BCC = this.encWord(sum);
    return Buffer.concat([PRE, LEN, core, BCC, EOT]);
  }
  paramsToData(paramsArr) {
    return Buffer.from(paramsArr.join("\t"), "ascii");
  }
  async sendCmd(cmdHex, paramsArr = [], options = {}) {
    const retries = Math.max(1, Number(options.retries || this.retryCount));
    const retryDelayMs = Math.max(0, Number(options.retryDelayMs || this.retryDelayMs));
    const cmdLabel = Number(cmdHex).toString(16).padStart(4, "0");

    const exec = this.queue.then(async () => {
      let attempt = 0;
      let lastResp = null;

      while (attempt < retries) {
        const resp = await this._sendCmdOnce(cmdHex, paramsArr);
        lastResp = resp;
        const { cmdHex: respCmdHex } = this.extractCmdAndError(resp);
        if (respCmdHex !== null) {
          return resp;
        }

        attempt += 1;
        if (attempt < retries) {
          console.warn(`↪️  [${this.id}] Fără răspuns complet pentru CMD=${cmdLabel}. Reîncerc (#${attempt + 1}/${retries})…`);
          if (retryDelayMs > 0) {
            await new Promise((res) => setTimeout(res, retryDelayMs));
          }
        }
      }

      const err = new Error(`NO_FRAME (timeout) dev=${this.id} cmd=${cmdLabel}`);
      err.code = "NO_FRAME";
      err.partialResponse = lastResp;
      throw err;
    });

    this.queue = exec.catch(() => {});
    return exec;
  }
  _sendCmdOnce(cmdHex, paramsArr = []) {
    const serial = this.serial;
    const dataBuf = this.paramsToData(paramsArr);
    const frame = this.buildFrame(cmdHex, dataBuf);

    return new Promise((resolve, reject) => {
      try {
        const ascii = dataBuf.toString("ascii").replace(/\x09/g, "<TAB>");
        console.log(`➡️  [${this.id}] TX CMD=${Number(cmdHex).toString(16).padStart(4, "0")} DATA="${ascii}"`);
        console.log("   TX HEX=", dataBuf.toString("hex").match(/.{1,2}/g)?.join(" "));
      } catch { }

      const chunks = [];
      const onData = (c) => chunks.push(c);

      serial.flush(() => {
        serial.on("data", onData);
        serial.write(frame, (err) => {
          if (err) {
            serial.off("data", onData);
            return reject(err);
          }
          const TOTAL_WAIT_MS = this.responseTimeout;
          const CHUNK_MS = 150;
          let waited = 0;
          const hasWrapped = (buf) => {
            const pre = buf.indexOf(0x01);
            const pst = buf.indexOf(0x05, pre + 1);
            const eot = buf.indexOf(0x03, pst + 1);
            return pre >= 0 && pst > pre && eot > pst;
          };
          (function pump() {
            const resp = Buffer.concat(chunks);
            if (!hasWrapped(resp)) {
              if (waited >= TOTAL_WAIT_MS) {
                serial.off("data", onData);
                if (resp.length) {
                  try {
                    console.warn(`↪️  [${this?.id || "?"}] Timeout, răspuns parțial (${resp.length} B):`, resp.toString("hex").match(/.{1,2}/g)?.join(" "));
                  } catch { }
                }
                console.log(`↩️ [${this?.id || "?"}] (timeout, fără frame complet)`);
                return resolve(resp);
              }
              waited += CHUNK_MS;
              return setTimeout(pump, CHUNK_MS);
            }
            serial.off("data", onData);
            console.log("↩️ Răspuns:", resp.toString("hex").match(/.{1,2}/g)?.join(" "));
            try {
              const pre = resp.indexOf(0x01);
              const pst = resp.indexOf(0x05, pre + 1);
              const CMDx4 = resp.slice(pre + 6, pre + 10);
              const n = (b) => (b - 0x30) & 0xF;
              const cmdVal = (n(CMDx4[0]) << 12) | (n(CMDx4[1]) << 8) | (n(CMDx4[2]) << 4) | n(CMDx4[3]);
              const dataBufResp = resp.slice(pre + 10, pst);
              const dataAscii = dataBufResp.toString("ascii");
              console.log(`🧩 CMD=${cmdVal.toString(16).padStart(4, "0")} DATA="${dataAscii}"`);
              const m = dataAscii.match(/-\d{6}/);
              if (m) console.log("❗ ErrorCode", m[0]); else console.log("✅ Fără cod de eroare explicit");
            } catch { }
            resolve(resp);
          })();
        });
      });
    });
  }
  extractCmdAndError(resp) {
    const pre = resp.indexOf(0x01);
    const pst = resp.indexOf(0x05, pre + 1);
    if (pre < 0 || pst < 0) return { cmdHex: null, ok: false, errorCode: "NO_FRAME", dataAscii: "", extra: {} };
    const CMDx4 = resp.slice(pre + 6, pre + 10);
    const n = (b) => (b - 0x30) & 0xF;
    const cmdVal = (n(CMDx4[0]) << 12) | (n(CMDx4[1]) << 8) | (n(CMDx4[2]) << 4) | n(CMDx4[3]);
    const cmdHex = cmdVal.toString(16).padStart(4, "0");
    const dataBufResp = resp.slice(pre + 10, pst);
    const dataAscii = dataBufResp.toString("ascii");
    const m = dataAscii.match(/-\d{6}/);
    const ok = !m;
    const errorCode = m ? m[0] : null;
    const extra = {};
    if (cmdHex === "0035" && ok) {
      const parts = dataAscii.split("\t");
      extra.payStatus = parts[1] || ""; // "D" (insuficient) / "R" (rest)
      extra.payAmount = parts[2] || ""; // diferența / restul
    }
    return { cmdHex, ok, errorCode, dataAscii, extra };
  }
  async assertOk(cmdHex, paramsArr = []) {
    const resp = await this.sendCmd(cmdHex, paramsArr);
    const { ok, errorCode, dataAscii } = this.extractCmdAndError(resp);
    if (!ok) throw new Error(errorCode || "DEVICE_ERROR");
    return dataAscii;
  }
}

// ── Inițializează device-urile ───────────────────────────────────────────────
const registry = new Map();
for (const d of DEVICES) {
  registry.set(d.id.toUpperCase(), new Device(d));
}
function getDev(req, res) {
  const id = String((req.query.dev || "A")).toUpperCase();
  const dev = registry.get(id);
  if (!dev) {
    res.status(400).json({ ok: false, error: `Unknown device '${id}'. Folosește ?dev=A sau ?dev=B` });
    return null;
  }
  return dev;
}

// ── Endpoints NEFISCAL ───────────────────────────────────────────────────────
app.post("/nf/open", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const data = await dev.assertOk(0x0026, ["", ""]); // 38: param gol + TAB final
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/nf/text", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const text = String(req.body?.text ?? "").slice(0, 48); // 42/48 col
    const params = [text, "", "", "", "", "", "", ""]; // 42: TAB final
    const data = await dev.assertOk(0x002A, params);
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/nf/close", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const data = await dev.assertOk(0x0027, [""]); // 39
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Endpoints FISCAL ─────────────────────────────────────────────────────────
app.post("/fiscal/open", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const op = String(req.body?.operator ?? "1");
    const pwd = String(req.body?.password ?? "0000");
    const till = String(req.body?.till ?? "1");
    const params = [op, pwd, till, ""]; // 0030 minim: 3 param + TAB final
    const data = await dev.assertOk(0x0030, params);
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/sale", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const name = String(req.body?.name ?? "ITEM").slice(0, 72);
    const tax = mapTaxCd(req.body?.tax);
    const price = toMoneyDot(req.body?.price ?? 0);
    const qty = req.body?.quantity == null ? "1.000" : toQtyDot(req.body.quantity);
    const dept = String(req.body?.department ?? "1");
    const unit = String(req.body?.unit ?? "BUC").slice(0, 6) || "X";
    const discType = "";
    const discVal = "";
    const params = [name, tax, price, qty, discType, discVal, dept, unit, ""]; // 0031: TAB final!
    const data = await dev.assertOk(0x0031, params);
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/text", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const text = String(req.body?.text ?? "").slice(0, 48);
    const resp = await dev.sendCmd(0x0034, [text, ""]); // {Text}<SEP>
    const dec = dev.extractCmdAndError(resp);
    if (!dec.ok) throw new Error(dec.errorCode || "DEVICE_ERROR");
    res.json({ ok: true, data: dec.dataAscii });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/pay", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const mode = mapPayMode(req.body?.mode);        // "0" cash, "6" card/modern
    const amount = toMoneyDot(req.body?.amount ?? 0); // "1.00"
    const resp = await dev.sendCmd(0x0035, [mode, amount, ""]); // 0035
    const dec = dev.extractCmdAndError(resp);
    if (!dec.ok) throw new Error(dec.errorCode || "DEVICE_ERROR");
    res.json({ ok: true, data: dec.dataAscii, status: dec.extra.payStatus, amount: dec.extra.payAmount });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/close", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const data = await dev.assertOk(0x0038, []); // 56
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/cancel", async (req, res) => {
  const dev = getDev(req, res); if (!dev) return;
  try {
    const data = await dev.assertOk(0x003C, []); // 60
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, devices: DEVICES.map(d => ({ id: d.id, path: d.path, baud: d.baud })) }));



app.use((req, _res, next) => {
  const ua = req.headers['user-agent'] || '';
  const origin = req.headers['origin'] || '';
  const isBrowser = !!origin || /Mozilla|Chrome|Safari|Edg/i.test(ua);
  console.log(`[REQ] ${req.method} ${req.url} | origin=${origin} | ua=${ua} | from=${isBrowser ? 'FRONTEND(browser)' : 'SERVER(side)'}`);
  next();
});


app.listen(HTTP_PORT, () => {
  console.log(`🚏 Bridge multi-device ascultă pe http://localhost:${HTTP_PORT}`);
  for (const d of DEVICES) {
    console.log(` • Device ${d.id}: ${d.path} @${d.baud}`);
  }
});
