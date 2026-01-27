import express from "express";
import cors from "cors";
import path from "path";

const app = express();

// ✅ dirname (ESM)
const __dirname = path.resolve();

// Body
app.use(express.json({ limit: "2mb" }));

// -------------------- CORS --------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW_NULL_ORIGIN =
  (process.env.ALLOW_NULL_ORIGIN || "true").toLowerCase() === "true";

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOW_NULL_ORIGIN && origin === "null") return cb(null, true);
      if (!allowedOrigins.length) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
  })
);

// ✅ Sirve estáticos desde RAÍZ (porque ahí tienes index.html y otc.html)
app.use(express.static(__dirname));

// -------------------- ENV --------------------
const LODGIFY_API_KEY =
  process.env.LODGIFY_API_KEY ||
  process.env.lodgify_api_key ||
  process.env.LODGIFY_APIKEY ||
  "";

const LODGIFY_BASE = (process.env.LODGIFY_BASE || "https://api.lodgify.com").replace(/\/+$/, "");

function requireApiKey() {
  if (!LODGIFY_API_KEY) {
    const e = new Error("Missing Lodgify API key. Set env var LODGIFY_API_KEY");
    // @ts-ignore
    e.statusCode = 500;
    throw e;
  }
}

async function lodgifyFetch(p, { method = "GET", headers = {}, body } = {}) {
  requireApiKey();
  const url = `${LODGIFY_BASE}${p.startsWith("/") ? "" : "/"}${p}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-ApiKey": LODGIFY_API_KEY,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { raw: txt };
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data
        ? (data.message || data.error || JSON.stringify(data))
        : String(txt);
    const err = new Error(`Lodgify ${res.status}: ${msg}`);
    // @ts-ignore
    err.statusCode = res.status;
    throw err;
  }

  return data;
}

// -------------------- Helpers --------------------
function parseISODate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}
function formatMMDDYYYY(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}
function nights(arrivalISO, departureISO) {
  const a = new Date(`${arrivalISO}T00:00:00Z`);
  const b = new Date(`${departureISO}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
}
function guessSourceLabel(b) {
  const src = (b?.source || "").toLowerCase();
  if (src.includes("airbnb")) return "Airbnb";
  if (src.includes("booking")) return "Booking.com";
  if (src.includes("vrbo")) return "Vrbo";
  if (src.includes("manual")) return "Manual";
  return b?.source || "Unknown";
}
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function fetchPropertiesMap() {
  const attempts = ["/v2/properties", "/v1/properties"];
  for (const p of attempts) {
    try {
      const data = await lodgifyFetch(p);
      const items = Array.isArray(data) ? data : (data?.items || data?.properties || []);
      const map = new Map();
      for (const it of items) {
        const id = it?.id ?? it?.property_id ?? it?.houseId;
        const name = it?.name ?? it?.title ?? it?.internal_name ?? it?.propertyName;
        if (id != null) map.set(Number(id), String(name ?? id));
      }
      if (map.size) return map;
    } catch {}
  }
  return new Map();
}

async function fetchAllBookings({ fromISO, toISO, limit = 50 }) {
  let offset = 0;
  const all = [];
  let guard = 0;

  while (guard++ < 2000) {
    let data = null;
    let lastErr = null;

    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      qs.set("offset", String(offset));
      qs.set("arrivalFrom", fromISO);
      qs.set("arrivalTo", toISO);
      data = await lodgifyFetch(`/v2/reservations/bookings?${qs.toString()}`);
    } catch (e) {
      lastErr = e;
    }

    if (!data) {
      try {
        const page = Math.floor(offset / limit) + 1;
        const qs = new URLSearchParams();
        qs.set("page", String(page));
        qs.set("pageSize", String(limit));
        qs.set("arrivalFrom", fromISO);
        qs.set("arrivalTo", toISO);
        data = await lodgifyFetch(`/v2/reservations/bookings?${qs.toString()}`);
      } catch (e) {
        lastErr = e;
      }
    }

    if (!data) throw lastErr || new Error("Failed fetching bookings");

    const batch = data?.bookings || data?.items || (Array.isArray(data) ? data : []);
    if (!Array.isArray(batch)) throw new Error("Unexpected bookings payload shape");

    all.push(...batch);

    const total = safeNum(data?.total_bookings) || safeNum(data?.total) || safeNum(data?.count) || null;
    if (total != null && all.length >= total) break;
    if (batch.length < limit) break;

    offset += batch.length;
  }

  return all;
}

function buildOTCRows({ bookings, propsMap, fromISO, toISO }) {
  const from = new Date(`${fromISO}T00:00:00Z`);
  const to = new Date(`${toISO}T23:59:59Z`);
  const rows = [];

  for (const b of bookings) {
    if (!b?.arrival || !b?.departure) continue;

    const a = new Date(`${b.arrival}T00:00:00Z`);
    if (a < from || a > to) continue;

    const dep = new Date(`${b.departure}T00:00:00Z`);
    const n = nights(b.arrival, b.departure);

    const houseId = Number(b.property_id);
    const houseName = propsMap.get(houseId) || String(houseId || "");

    const roomTypeIds = (b.rooms || []).map((r) => r.room_type_id).filter(Boolean);
    const guest = b.guest || {};
    const gb = (b.rooms && b.rooms[0] && b.rooms[0].guest_breakdown) || {};

    const base = {
      Id: b.id,
      Source: guessSourceLabel(b),
      SourceText: b.source_text || "",
      ChannelBooking: (typeof b.source_text === "string" && b.source_text.length <= 30) ? b.source_text : "",
      Status: b.status || "",
      DateCancelled: b.canceled_at ? formatMMDDYYYY(new Date(`${b.canceled_at}Z`)) : "",
      DateArrival: formatMMDDYYYY(a),
      DateDeparture: formatMMDDYYYY(dep),
      Nights: n,
      HouseName: houseName,
      HouseId: houseId || "",
      RoomTypeNames: houseName,
      RoomTypeIds: roomTypeIds.join(","),
      GuestName: guest.name || "",
      GuestEmail: guest.email || "",
      NumberOfGuests: safeNum((b.rooms && b.rooms[0] && b.rooms[0].people) || 0),
      Adults: safeNum(gb.adults),
      Children: safeNum(gb.children),
      Infants: safeNum(gb.infants),
      Pets: safeNum(gb.pets),
      Currency: b.currency_code || "",
    };

    const st = b.subtotals || {};
    const lineItems = [];

    const stay = safeNum(st.stay);
    if (stay) lineItems.push({ LineItem: "RoomRate", LineItemDescription: "Tarifa diaria", GrossAmount: stay });

    const fees = safeNum(st.fees);
    if (fees) lineItems.push({ LineItem: "Fee", LineItemDescription: "Fees", GrossAmount: fees });

    const taxes = safeNum(st.taxes);
    if (taxes) lineItems.push({ LineItem: "Tax", LineItemDescription: "Taxes", GrossAmount: taxes });

    const addons = safeNum(st.addons);
    if (addons) lineItems.push({ LineItem: "Addon", LineItemDescription: "Add-ons", GrossAmount: addons });

    const promos = safeNum(st.promotions);
    if (promos) lineItems.push({ LineItem: "Promotion", LineItemDescription: "Promotions", GrossAmount: promos });

    const vat = safeNum(st.vat);
    if (vat) lineItems.push({ LineItem: "VAT", LineItemDescription: "VAT", GrossAmount: vat });

    if (!lineItems.length) {
      const total = safeNum(b.total_amount);
      if (total) lineItems.push({ LineItem: "Total", LineItemDescription: "Total", GrossAmount: total });
    }

    for (const li of lineItems) {
      rows.push({
        ...base,
        LineItem: li.LineItem,
        LineItemDescription: li.LineItemDescription,
        GrossAmount: Number(li.GrossAmount.toFixed(2)),
        NetAmount: Number(li.GrossAmount.toFixed(2)),
        VatAmount: 0,
      });
    }
  }

  return rows;
}

function rowsToCSV(rows) {
  const cols = [
    "Id","Source","SourceText","ChannelBooking","Status","DateCancelled",
    "DateArrival","DateDeparture","Nights","HouseName","HouseId",
    "RoomTypeNames","RoomTypeIds","GuestName","GuestEmail",
    "NumberOfGuests","Adults","Children","Infants","Pets","Currency",
    "LineItem","LineItemDescription","GrossAmount","NetAmount","VatAmount"
  ];
  const esc = (v) => {
    const s = (v ?? "").toString();
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"','""')}"`;
    return s;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(",")),
  ].join("\n");
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/_ping", async (req, res) => {
  try {
    const today = new Date();
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
    const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    const fromISO = from.toISOString().slice(0,10);
    const toISO = to.toISOString().slice(0,10);

    const bookings = await fetchAllBookings({ fromISO, toISO, limit: 50 });
    res.json({ ok: true, sampleCount: bookings.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/otc", async (req, res) => {
  try {
    const fromISO = String(req.query.from || "");
    const toISO = String(req.query.to || "");
    if (!parseISODate(fromISO) || !parseISODate(toISO)) {
      return res.status(400).json({ ok: false, error: "Use query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD" });
    }

    const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));

    const [propsMap, bookings] = await Promise.all([
      fetchPropertiesMap(),
      fetchAllBookings({ fromISO, toISO, limit }),
    ]);

    const rows = buildOTCRows({ bookings, propsMap, fromISO, toISO });

    res.json({ ok: true, from: fromISO, to: toISO, rowsCount: rows.length, bookingsCount: bookings.length, rows });
  } catch (e) {
    const code = e?.statusCode ? Number(e.statusCode) : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/otc.csv", async (req, res) => {
  try {
    const fromISO = String(req.query.from || "");
    const toISO = String(req.query.to || "");
    if (!parseISODate(fromISO) || !parseISODate(toISO)) {
      return res.status(400).send("Use query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD");
    }

    const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));

    const [propsMap, bookings] = await Promise.all([
      fetchPropertiesMap(),
      fetchAllBookings({ fromISO, toISO, limit }),
    ]);

    const rows = buildOTCRows({ bookings, propsMap, fromISO, toISO });
    const csv = rowsToCSV(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="OTCReport_${fromISO}_to_${toISO}.csv"`);
    res.send(csv);
  } catch (e) {
    const code = e?.statusCode ? Number(e.statusCode) : 500;
    res.status(code).send(String(e?.message || e));
  }
});

// ✅ Home (sirve el index.html que está en la raíz)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ checkinnreservas API running on port ${PORT}`);
});
