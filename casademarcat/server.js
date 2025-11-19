// server.js — Bridge pentru Datecs DP-05 (NU DP-05C)
// End-pointuri identice cu cele folosite anterior în proiect: /nf/* și /fiscal/*
// - Baud by default 115200 (conform setării recente)
// - Așteptare corectă de răspuns (SYN loop)
// - TAB final pentru comenzi care îl cer (49, 53 etc.)
// - Tratare erori hârtie (NO_PAPER)

const express = require("express");
const { SerialPort } = require("serialport");

// ── Config (ENV) ─────────────────────────────────────────────────────────────
const HTTP_PORT   = Number(process.env.HTTP_PORT || 9000);
const SERIAL_PATH = process.env.SERIAL_PATH || "COM6";
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD || 115200);

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── Serial ───────────────────────────────────────────────────────────────────
const serial = new SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD }, (err) => {
  if (err) console.error("❌ Serial open:", err.message);
  else console.log(`✅ Conectat la Datecs DP-05 pe ${SERIAL_PATH} @${SERIAL_BAUD}`);
});

// ── Helpers protocol Datecs (LEN/CMD/BCC nibbles + 0x30) ─────────────────────
let seq = 0x20;
function encWord(word16) {
  const n3 = (word16 >> 12) & 0xF, n2 = (word16 >> 8) & 0xF, n1 = (word16 >> 4) & 0xF, n0 = word16 & 0xF;
  return Buffer.from([0x30 + n3, 0x30 + n2, 0x30 + n1, 0x30 + n0]);
}
function buildFrame(cmdHex, dataBuf = Buffer.alloc(0)) {
  const PRE = Buffer.from([0x01]), PST = Buffer.from([0x05]), EOT = Buffer.from([0x03]);
  seq = seq >= 0xFF ? 0x20 : seq + 1;
  const SEQ = Buffer.from([seq]);
  const CMD = encWord(cmdHex & 0xFFFF);
  const core = Buffer.concat([SEQ, CMD, dataBuf, PST]);
  const lenValue = core.length + 4 /*LEN*/ + 0x20;
  const LEN = encWord(lenValue & 0xFFFF);
  let sum = 0;
  for (const b of Buffer.concat([LEN, core])) sum = (sum + b) & 0xFFFF;
  const BCC = encWord(sum);
  return Buffer.concat([PRE, LEN, core, BCC, EOT]);
}
function paramsToData(paramsArr) {
  // Important: TAB după ultimul parametru dacă e "" în listă.
  return Buffer.from(paramsArr.join("\t"), "ascii");
}

// ── Low-level send (SYN loop + așteptare frame complet) ──────────────────────
async function sendCmd(cmdHex, paramsArr = []) {
  return new Promise((resolve, reject) => {
    const dataBuf = paramsToData(paramsArr);
    const frame = buildFrame(cmdHex, dataBuf);

    // Log util (ASCII + HEX)
    try {
      const ascii = dataBuf.toString("ascii").replace(/\x09/g, "<TAB>");
      console.log(`➡️  TX CMD=${Number(cmdHex).toString(16).padStart(4, "0")} DATA="${ascii}"`);
      console.log("   TX HEX=", dataBuf.toString("hex").match(/.{1,2}/g)?.join(" "));
    } catch {}

    const chunks = [];
    const onData = (c) => chunks.push(c);

    serial.flush(() => {
      serial.on("data", onData);
      serial.write(frame, (err) => {
        if (err) {
          serial.off("data", onData);
          return reject(err);
        }
        const TOTAL_WAIT_MS = 4000; // suficient pentru 0038
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
              console.log("↩️ (timeout, fără frame complet)");
              return resolve(resp);
            }
            waited += CHUNK_MS;
            return setTimeout(pump, CHUNK_MS); // tolerează 0x16 repetat
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
          } catch {}
          resolve(resp);
        })();
      });
    });
  });
}

function extractCmdAndError(resp) {
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

async function assertOk(cmdHex, paramsArr = []) {
  const resp = await sendCmd(cmdHex, paramsArr);
  const { ok, errorCode, dataAscii } = extractCmdAndError(resp);
  if (!ok) throw new Error(errorCode || "DEVICE_ERROR");
  return dataAscii;
}

function isPaperError(e) {
  const msg = String(e?.message || e || "");
  return msg.includes("-111008") || msg.includes("-111009"); // NO_PAPER / PRINTER_ERROR
}

// ── Utils conversii ──────────────────────────────────────────────────────────
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
  if (s === "CARD" || s === "MODERN" || s === "6" || s === "1") return "6"; // mapăm card → 6
  if (s === "CASH" || s === "0") return "0";
  return /^[0-9]$/.test(s) ? s : "0";
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEFISCAL
// ─────────────────────────────────────────────────────────────────────────────
app.post("/nf/open", async (req, res) => {
  try {
    const data = await assertOk(0x0026, ["", ""]); // 38: param gol + TAB final
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/nf/text", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").slice(0, 48); // 42/48 col
    const params = [text, "", "", "", "", "", "", ""]; // Cmd 42: TAB final
    const data = await assertOk(0x002A, params);
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/nf/close", async (_req, res) => {
  try {
    const data = await assertOk(0x0027, [""]); // 39
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  FISCAL
// ─────────────────────────────────────────────────────────────────────────────
app.post("/fiscal/open", async (req, res) => {
  try {
    const op   = String(req.body?.operator ?? "1");
    const pwd  = String(req.body?.password ?? "0000");
    const till = String(req.body?.till ?? "1");
    const params = [op, pwd, till, ""]; // 0030 minim: 3 param + TAB final
    const data = await assertOk(0x0030, params);
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/sale", async (req, res) => {
  try {
    const name  = String(req.body?.name ?? "ITEM").slice(0, 72);
    const tax   = mapTaxCd(req.body?.tax);
    const price = toMoneyDot(req.body?.price ?? 0);
    const qty   = req.body?.quantity == null ? "1.000" : toQtyDot(req.body.quantity);
    const dept  = String(req.body?.department ?? "1");
    const unit  = String(req.body?.unit ?? "BUC").slice(0, 6) || "X";
    const discType = ""; // fără discount
    const discVal  = "";
    const params = [name, tax, price, qty, discType, discVal, dept, unit, ""]; // 0031: TAB final
    const data = await assertOk(0x0031, params);
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/text", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").slice(0, 48);
    const resp = await sendCmd(0x0034, [text, ""]); // {Text}<SEP>
    const dec  = extractCmdAndError(resp);
    if (!dec.ok) throw new Error(dec.errorCode || "DEVICE_ERROR");
    res.json({ ok: true, data: dec.dataAscii });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/pay", async (req, res) => {
  try {
    const mode   = mapPayMode(req.body?.mode);        // "0" cash, "6" card/modern
    const amount = toMoneyDot(req.body?.amount ?? 0); // "1.00"
    const resp = await sendCmd(0x0035, [mode, amount, ""]); // 0035: {PaidMode}{Amount}<SEP>
    const dec  = extractCmdAndError(resp);
    if (!dec.ok) throw new Error(dec.errorCode || "DEVICE_ERROR");
    res.json({ ok: true, data: dec.dataAscii, status: dec.extra.payStatus, amount: dec.extra.payAmount });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/close", async (_req, res) => {
  try {
    const data = await assertOk(0x0038, []); // 56
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/fiscal/cancel", async (_req, res) => {
  try {
    const data = await assertOk(0x003C, []); // 60
    res.json({ ok: true, data });
  } catch (e) {
    if (isPaperError(e)) return res.status(409).json({ ok: false, error: "NO_PAPER", code: String(e.message || e) });
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Listen ───────────────────────────────────────────────────────────────────
app.listen(HTTP_PORT, () => {
  console.log(`🚏 Bridge Datecs DP-05 ascultă pe http://localhost:${HTTP_PORT}`);
});
